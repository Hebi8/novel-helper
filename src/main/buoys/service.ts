import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	ANSWER_TOKENS,
	BUOY_VERSION,
	bridgeTo,
	buoyPath,
	choices,
	choose,
	hasOpenMarks,
	initialPosition,
	inNode,
	JUDGE_LEAD_CHARS,
	JUDGE_TEXT_CHARS,
	judgePrompt,
	locate,
	markAt,
	parallelWith,
	parseBuoyFile,
	readJudgement,
	readRelocation,
	RELOCATE_TEXT_CHARS,
	relocatePrompt,
	resolve,
	serializeBuoyFile,
	stateOf,
	step,
	type BuoyFile,
	type Position,
	type MarkSource,
	type PromptText,
} from '../../core/buoy';
import { frontmatterLength, stem } from '../../core/text';
import { costOf, ratesFor, usageKey } from '../../core/usage';
import { ask } from '../../llm/client';
import type { ProviderId } from '../../llm/providers';
import type { OutlineGraph } from '../../core/outline';
import type { BuoyAction, BuoyStatus } from '../../shared/api';
import type { UsageStore } from '../../storage/usageStore';
import type { SettingsStore } from '../settings/store';
import type { BookIndex } from '../book/indexer';
import { atomicWrite, readAuxiliaryOptional } from '../book/files';
import { bookPath } from '../book/paths';
import { zh } from '../../renderer/strings';
const bodyLength = (text: string) => text.length - frontmatterLength(text);
export interface ChapterPosition {
	chapter: string;
	graph: OutlineGraph;
	file?: BuoyFile;
	position?: Position;
	lost: boolean;
	unreadable: string[];
}
export class Buoys {
	private last: Promise<unknown> = Promise.resolve();
	private running = new Map<string, Promise<unknown>>();
	private manual = new Set<Promise<unknown>>();
	private controllers = new Set<AbortController>();
	private searchAgainAt = new Map<string, number>();
	private disposed = false;
	onChanged: () => void = () => {};
	onError: (error: unknown) => void = () => {};
	beforeWrite: <T>(work: () => Promise<T>) => Promise<T> = (work) => work();
	constructor(
		readonly index: BookIndex,
		private settings: SettingsStore,
		private usage: UsageStore,
		private getKey: (provider: ProviderId) => string | undefined,
		private request: typeof ask = ask,
	) {}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const done = this.last.then(work);
		this.last = done.catch(() => undefined);
		return done;
	}
	private async write(chapter: string, file: BuoyFile): Promise<void> {
		await this.beforeWrite(async () => {
			const full = join(this.index.root, buoyPath(bookPath(chapter)));
			await mkdir(dirname(full), { recursive: true });
			await atomicWrite(full, serializeBuoyFile({ ...file, chapter }));
		});
	}
	private async load(chapter: string, currentText?: string): Promise<BuoyFile | undefined> {
		const raw = await readAuxiliaryOptional(this.index.root, buoyPath(bookPath(chapter)), this.index.inICloud);
		if (raw === undefined) {
			return undefined;
		}
		if (!hasOpenMarks(raw)) {
			return parseBuoyFile(raw);
		}
		const text = currentText ?? (await this.index.read(chapter)).text;
		const file = parseBuoyFile(raw, (state) => markAt(text, bodyLength(text), state, 'assistant', new Date()))!;
		await this.write(chapter, file);
		return file;
	}
	async read(chapter: string, text?: string): Promise<ChapterPosition> {
		const [graph, file] = await Promise.all([this.index.outline(), this.serial(() => this.load(chapter, text))]);
		const last = file?.marks.at(-1);
		const position = last && resolve(graph, last.state);
		const unreadable = graph.unreadable.filter((path) =>
			last?.state.nodes.some((node) => node.id === path || node.id.startsWith(path + '#')),
		);
		return { chapter, graph, file, position, lost: last !== undefined && position === undefined, unreadable };
	}
	async status(chapter: string, text?: string): Promise<BuoyStatus> {
		const at = await this.read(chapter, text);
		return { chapter, state: at.position ? stateOf(at.position) : at.file?.marks.at(-1)?.state, lost: at.lost, unreadable: at.unreadable };
	}
	async prepare(chapter: string, text: string): Promise<ChapterPosition> {
		const at = await this.read(chapter, text);
		if (at.file?.marks.length || !at.graph.leaves.length || bodyLength(text) >= 200) {
			return at;
		}
		const before = this.index.library.previousChapters(chapter, 1)[0];
		const previous = before === undefined ? undefined : (await this.serial(() => this.load(before)))?.marks.at(-1)?.state;
		const position = initialPosition(at.graph, previous, this.index.library.companionOf('outline', chapter));
		return position ? this.place(at, position, 'init', text) : at;
	}
	private async place(at: ChapterPosition, position: Position, by: MarkSource, text: string): Promise<ChapterPosition> {
		const file = await this.serial(async () => {
			const now = (await this.load(at.chapter)) ?? { version: BUOY_VERSION, chapter: at.chapter, marks: [] };
			if (by === 'init' && now.marks.length) {
				return now;
			}
			now.marks.push(markAt(text, bodyLength(text), stateOf(position), by, new Date()));
			await this.write(at.chapter, now);
			return now;
		});
		this.onChanged();
		const current = resolve(at.graph, file.marks.at(-1)!.state);
		return { ...at, file, position: current, lost: current === undefined };
	}
	update(at: ChapterPosition, text: string): void {
		const every = this.settings.get()['position.updateChars'];
		const chars = bodyLength(text);
		if (this.disposed || every <= 0 || this.running.has(at.chapter) || !at.graph.leaves.length) {
			return;
		}
		let job: Promise<unknown>;
		if (!at.position) {
			if (at.unreadable.length || chars < 200 || chars < (this.searchAgainAt.get(at.chapter) ?? 0)) {
				return;
			}
			job = this.search(at, text).then((found) => {
				if (found === false) {
					this.searchAgainAt.set(at.chapter, chars + every);
				}
			});
		} else if (chars - at.file!.marks.at(-1)!.chars >= every) {
			job = this.judge(at, text);
		} else {
			return;
		}
		this.running.set(at.chapter, job);
		void job.catch(this.onError).finally(() => this.running.delete(at.chapter));
	}
	private async ask(prompt: PromptText, manual = false): Promise<string | undefined> {
		await this.usage.load();
		const settings = this.settings.get();
		const model = this.settings.model();
		const apiKey = this.getKey(model.provider);
		if (
			this.disposed ||
			(model.keyRequired && !apiKey) ||
			(!manual && (!settings.enabled || this.usage.overLimit(settings['usage.dailyLimitUsd'])))
		) {
			return;
		}
		const controller = new AbortController();
		this.controllers.add(controller);
		const answer = await this.request(
			{
				...model,
				apiKey,
				system: prompt.system,
				user: [{ text: prompt.user, cache: false }],
				maxTokens: ANSWER_TOKENS,
			},
			controller.signal,
		);
		if (answer.usage) {
			const rates = ratesFor(model.model, new Date(), model.pricing, this.settings.prices());
			await this.usage.add(
				usageKey(model.provider, model.model, 'position'),
				answer.usage,
				rates ? costOf(answer.usage, rates) : undefined,
			);
		}
		this.controllers.delete(controller);
		if (controller.signal.aborted) {
			return;
		}
		if (answer.error !== undefined) {
			this.onError(answer.error);
			return;
		}
		return answer.text;
	}
	private async commitAnswer(at: ChapterPosition, position: Position, by: MarkSource, text: string): Promise<boolean> {
		// Check and append under the same queue: a manual mark must never be overtaken by a model reply.
		const changed = await this.serial(async () => {
			const now = await this.load(at.chapter);
			if (
				this.disposed ||
				(await this.index.outline()) !== at.graph ||
				(now && serializeBuoyFile(now)) !== (at.file && serializeBuoyFile(at.file))
			) {
				return false;
			}
			const file = now ?? { version: BUOY_VERSION, chapter: at.chapter, marks: [] };
			file.marks.push(markAt(text, bodyLength(text), stateOf(position), by, new Date()));
			await this.write(at.chapter, file);
			return true;
		});
		if (changed) {
			this.onChanged();
		}
		return changed;
	}
	private async judge(at: ChapterPosition, text: string): Promise<void> {
		const position = at.position!;
		const lists = choices(at.graph, position);
		const start = frontmatterLength(text);
		const from = Math.max(start, locate(text, at.file!.marks.at(-1)!) - JUDGE_LEAD_CHARS, text.length - JUDGE_TEXT_CHARS);
		const answer = await this.ask(judgePrompt(position, lists, text.slice(from), from > start));
		if (answer !== undefined) {
			await this.commitAnswer(at, choose(position, readJudgement(answer, lists)), 'auto', text);
		}
	}
	private async search(at: ChapterPosition, text: string, manual = false): Promise<boolean | undefined> {
		const start = frontmatterLength(text);
		const from = Math.max(start, text.length - RELOCATE_TEXT_CHARS);
		const answer = await this.ask(relocatePrompt(at.graph, stem(at.chapter), text.slice(from), from > start), manual);
		if (answer === undefined) {
			return;
		}
		const leaf = readRelocation(answer, at.graph);
		return leaf ? this.commitAnswer(at, inNode(leaf), 'relocate', text) : false;
	}
	async act(chapter: string, action: BuoyAction, nodeId?: string): Promise<void> {
		bookPath(chapter);
		if (!this.index.library.isChapter(chapter)) {
			throw new Error(zh.buoyNoChapter);
		}
		const at = await this.read(chapter);
		const text = (await this.index.read(chapter)).text;
		if (at.unreadable.length && ['forward', 'back', 'relocate'].includes(action)) {
			throw new Error(zh.buoyUnreadable(at.unreadable));
		}
		if (!at.graph.leaves.length) {
			throw new Error(zh.buoyEmpty);
		}
		if (action === 'relocate') {
			if (!text.slice(frontmatterLength(text)).trim()) {
				throw new Error(zh.buoyNoText);
			}
			const job = this.search(at, text, true);
			this.manual.add(job);
			let found: boolean | undefined;
			try {
				found = await job;
			} finally {
				this.manual.delete(job);
			}
			if (!found) {
				throw new Error(zh.buoyNotLocated);
			}
			return;
		}
		let position: Position | undefined;
		if (action === 'forward' || action === 'back') {
			if (!at.position) {
				throw new Error(zh.buoyUnset);
			}
			position = step(at.graph, at.position, action);
			if (!position) {
				throw new Error(action === 'forward' ? zh.buoyLast : zh.buoyFirst);
			}
		} else if (action === 'dropSecond') {
			if (at.position && at.position.kind !== 'in') {
				position = inNode(at.position.nodes[0]);
			}
		} else {
			const node = at.graph.nodes.get(nodeId!);
			if (!node) {
				throw new Error(zh.buoyMissing);
			}
			position = action === 'in' ? inNode(node) : action === 'bridge' ? bridgeTo(at.position, node) : parallelWith(at.position, node);
		}
		if (position) {
			await this.place(at, position, 'manual', text);
		}
	}
	cancel(): void {
		this.controllers.forEach((controller) => controller.abort());
	}
	async drain(): Promise<void> {
		await Promise.all([...this.running.values(), ...this.manual]);
		await this.last;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		this.cancel();
		await Promise.allSettled([...this.running.values(), ...this.manual]);
		await this.last;
	}
}
