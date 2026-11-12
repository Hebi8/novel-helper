// The buoys of each chapter: reads and writes their files in the story
// folder, gives a chapter that is just starting its first position, asks the
// model now and then whether the chapter has moved on, and carries out what
// the writer does to them by hand.

import * as vscode from 'vscode';
import {
	ANSWER_TOKENS,
	BUOY_FOLDER,
	BUOY_VERSION,
	type BuoyFile,
	bridgeTo,
	buoyPath,
	choices,
	choose,
	initialPosition,
	inNode,
	JUDGE_LEAD_CHARS,
	JUDGE_TEXT_CHARS,
	judgePrompt,
	locate,
	markAt,
	type MarkSource,
	parallelWith,
	parseBuoyFile,
	type Position,
	type PromptText,
	readJudgement,
	readRelocation,
	RELOCATE_TEXT_CHARS,
	relocatePrompt,
	renameState,
	resolve,
	serializeBuoyFile,
	stateOf,
	step,
} from '../core/buoy';
import type { OutlineGraph, OutlineNode } from '../core/outline';
import { frontmatterLength, stem } from '../core/text';
import type { Usage } from '../core/usage';
import { ask } from '../llm/client';
import { type ModelSettings, modelSettings, positionUpdateChars, secretKey } from './config';
import { type FolderIndex, readText, type WorkspaceIndexes } from './workspaceIndex';

/** A chapter with less text than this is at its start: it gets its first position without asking the model, and the model is not asked to search for it. */
const STARTED_CHARS = 200;

export interface ChapterPosition {
	index: FolderIndex;
	/** The chapter, relative to the story folder. */
	chapter: string;
	graph: OutlineGraph;
	file?: BuoyFile;
	/** Undefined when the chapter has no buoys yet, or they are lost. */
	position?: Position;
	/** The last mark names a node that is no longer in the outline. */
	lost: boolean;
}

export interface BuoyHooks {
	indexes: WorkspaceIndexes;
	secrets: vscode.SecretStorage;
	log: vscode.LogOutputChannel;
	/** Whether automatic requests have stopped for the day. */
	overLimit(): boolean;
	/** Called for every request the provider took. */
	recordUsage(model: ModelSettings, usage: Usage): void;
}

function bodyLength(text: string): number {
	return text.length - frontmatterLength(text);
}

/** `in 【A】`, `on the way from 【A】 to 【B】`: the buoys in words. */
export function describePosition(kind: Position['kind'], titles: readonly string[]): string {
	const [first, second = ''] = titles.map((title) => `【${title}】`);
	if (kind === 'bridge') {
		return vscode.l10n.t('on the way from {0} to {1}', first, second);
	}
	return kind === 'parallel' ? vscode.l10n.t('in {0} and {1} at once', first, second) : vscode.l10n.t('in {0}', first);
}

export class Buoys implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when a chapter's buoys change, and when another chapter becomes the one being written. */
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[];
	/** Chapters the model is being asked about. */
	private readonly running = new Set<string>();
	/** After the model's search named no node: the length of the chapter's text at which it is asked again. */
	private readonly searchAgainAt = new Map<string, number>();
	/** The chapter last in the editor: what the commands and the outline view are about, also while an outline file has the focus. */
	private chapter?: { index: FolderIndex; path: string };

	constructor(private readonly hooks: BuoyHooks) {
		this.disposables = [
			this.changed,
			vscode.window.onDidChangeActiveTextEditor(() => this.follow()),
			vscode.workspace.onDidRenameFiles((event) => this.renamed(event.files)),
			// The index is built again after settings change: the chapter is looked up again then.
			hooks.indexes.onDidChange(() => this.follow()),
		];
		void this.follow();
	}

	/** Takes the chapter in the editor as the one being written; with something else in the editor, the last one stays. */
	private async track(): Promise<void> {
		const document = vscode.window.activeTextEditor?.document;
		const located = document && (await this.hooks.indexes.locate(document));
		if (located?.index.library.isChapter(located.path)) {
			this.chapter = { index: located.index, path: located.path };
		} else if (this.chapter) {
			// The same chapter in the index as it is now, if it is still there.
			const index = await this.hooks.indexes.get(this.chapter.index.folder);
			this.chapter = index.library.isChapter(this.chapter.path) ? { index, path: this.chapter.path } : undefined;
		}
	}

	private async follow(): Promise<void> {
		await this.track();
		this.changed.fire();
	}

	private async readFile(index: FolderIndex, chapter: string): Promise<BuoyFile | undefined> {
		try {
			return parseBuoyFile(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(index.uri(buoyPath(chapter)))));
		} catch {
			return undefined;
		}
	}

	private async writeFile(index: FolderIndex, file: BuoyFile): Promise<void> {
		const uri = index.uri(buoyPath(file.chapter));
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeBuoyFile(file)));
	}

	/** Where a chapter is, going by its last mark and the outline as it is now. */
	async read(index: FolderIndex, chapter: string): Promise<ChapterPosition> {
		const [graph, file] = await Promise.all([index.outline(), this.readFile(index, chapter)]);
		const last = file?.marks.at(-1);
		const position = last && resolve(graph, last.state);
		return { index, chapter, graph, file, position, lost: last !== undefined && position === undefined };
	}

	/** The chapter last in the editor and where it is; undefined when no chapter has been opened. */
	async current(): Promise<ChapterPosition | undefined> {
		await this.track();
		return this.chapter && this.read(this.chapter.index, this.chapter.path);
	}

	/**
	 * Where a chapter is, for a continuation request. A chapter with no mark
	 * that is just starting gets its first position here, without asking the
	 * model: where the chapter before it ended, else the first leaf of the
	 * outline file that goes with it by its path.
	 */
	async prepare(index: FolderIndex, chapter: string, text: string): Promise<ChapterPosition> {
		const at = await this.read(index, chapter);
		if (at.file?.marks.length || !at.graph.leaves.length || bodyLength(text) >= STARTED_CHARS) {
			return at;
		}
		const before = index.library.previousChapters(chapter, 1)[0];
		const previous = before === undefined ? undefined : (await this.readFile(index, before))?.marks.at(-1)?.state;
		const position = initialPosition(at.graph, previous, index.library.companionOf('outline', chapter));
		return position ? this.place(at, position, 'init', text) : at;
	}

	/** Adds a mark at the end of the chapter's text as it is now. */
	private async place(at: ChapterPosition, position: Position, by: MarkSource, text: string): Promise<ChapterPosition> {
		const file = at.file ?? { version: BUOY_VERSION, chapter: at.chapter, marks: [] };
		file.marks.push(markAt(text, bodyLength(text), stateOf(position), by, new Date()));
		await this.writeFile(at.index, file);
		this.changed.fire();
		return { ...at, file, position, lost: false };
	}

	/**
	 * Called when a continuation is about to be asked for: if the chapter has
	 * grown enough since its last mark, the model is asked, in the background,
	 * whether the buoys moved; a chapter with text and no buoys (none yet, or
	 * lost) has the model search the whole outline for its place. One request
	 * per chapter at a time; one that fails is made again at the next call.
	 */
	update(at: ChapterPosition, text: string): void {
		const key = at.index.uri(at.chapter).toString();
		const every = positionUpdateChars(at.index.folder.uri);
		const chars = bodyLength(text);
		if (every <= 0 || this.running.has(key) || !at.graph.leaves.length || this.hooks.overLimit()) {
			return;
		}
		let job: Promise<unknown>;
		if (!at.position) {
			if (chars < STARTED_CHARS || chars < (this.searchAgainAt.get(key) ?? 0)) {
				return;
			}
			job = this.search(at, text).then((found) => {
				if (found === false) {
					this.searchAgainAt.set(key, chars + every);
				}
			});
		} else if (chars - at.file!.marks.at(-1)!.chars >= every) {
			job = this.judge(at, text);
		} else {
			return;
		}
		this.running.add(key);
		void job
			.catch((error) => this.hooks.log.warn(`${at.chapter}: position not updated: ${error instanceof Error ? error.message : String(error)}`))
			.finally(() => this.running.delete(key));
	}

	/** The model's answer to a prompt; undefined when it could not be asked or the request failed. */
	private async ask(prompt: PromptText): Promise<string | undefined> {
		const model = modelSettings();
		const apiKey = await this.hooks.secrets.get(secretKey(model.provider));
		if (model.keyRequired && !apiKey) {
			return undefined;
		}
		const answer = await ask({ ...model, apiKey, system: prompt.system, user: [{ text: prompt.user, cache: false }], maxTokens: ANSWER_TOKENS });
		if (answer.usage) {
			this.hooks.recordUsage(model, answer.usage);
		}
		if (answer.error !== undefined) {
			this.hooks.log.warn(`${model.provider}/${model.model}: position request failed: ${answer.error}`);
			return undefined;
		}
		return answer.text;
	}

	/** Whether a mark was added to the chapter while the model was being asked: the writer moved the buoys, and that stands. */
	private async overtaken(at: ChapterPosition): Promise<boolean> {
		return ((await this.readFile(at.index, at.chapter))?.marks.length ?? 0) !== (at.file?.marks.length ?? 0);
	}

	/** Asks whether the buoys moved since the last mark, and marks where they are now. */
	private async judge(at: ChapterPosition, text: string): Promise<void> {
		const position = at.position!;
		const lists = choices(at.graph, position);
		const start = frontmatterLength(text);
		const from = Math.max(start, locate(text, at.file!.marks.at(-1)!) - JUDGE_LEAD_CHARS, text.length - JUDGE_TEXT_CHARS);
		const answer = await this.ask(judgePrompt(position, lists, text.slice(from), from > start));
		if (answer === undefined || (await this.overtaken(at))) {
			return;
		}
		await this.place(at, choose(position, readJudgement(answer, lists)), 'auto', text);
	}

	/**
	 * Has the model pick the leaf the end of the chapter is in, out of the
	 * whole outline. True when it did; false when its answer named none;
	 * undefined when it could not be asked.
	 */
	private async search(at: ChapterPosition, text: string): Promise<boolean | undefined> {
		const start = frontmatterLength(text);
		const from = Math.max(start, text.length - RELOCATE_TEXT_CHARS);
		const answer = await this.ask(relocatePrompt(at.graph, stem(at.chapter), text.slice(from), from > start));
		if (answer === undefined || (await this.overtaken(at))) {
			return undefined;
		}
		const leaf = readRelocation(answer, at.graph);
		if (leaf) {
			await this.place(at, inNode(leaf), 'relocate', text);
		}
		return leaf !== undefined;
	}

	/** The chapter the commands work on, with its text; tells the writer when there is none. */
	private async target(): Promise<{ at: ChapterPosition; text: string } | undefined> {
		const at = await this.current();
		if (!at) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Open a chapter first: the position on the outline belongs to a chapter.'));
			return undefined;
		}
		if (!at.graph.leaves.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('There is nothing in the outline yet to be at.'));
			return undefined;
		}
		return { at, text: await readText(at.index.uri(at.chapter)) };
	}

	/** Puts the buoys where the writer says: in a node, on the way to it from the first buoy, or in it as well as in the first buoy's node. */
	async put(nodeId: string, move: 'in' | 'bridge' | 'parallel'): Promise<void> {
		const target = await this.target();
		const node = target?.at.graph.nodes.get(nodeId);
		if (!target || !node) {
			return;
		}
		const { position } = target.at;
		await this.place(target.at, move === 'in' ? inNode(node) : move === 'bridge' ? bridgeTo(position, node) : parallelWith(position, node), 'manual', target.text);
	}

	/** Leaves the first buoy alone in its node. */
	async dropSecond(): Promise<void> {
		const target = await this.target();
		if (target?.at.position && target.at.position.kind !== 'in') {
			await this.place(target.at, inNode(target.at.position.nodes[0]), 'manual', target.text);
		}
	}

	/** One step along the main line. */
	async move(direction: 'forward' | 'back'): Promise<void> {
		const target = await this.target();
		if (!target) {
			return;
		}
		if (!target.at.position) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('{0} has no position on the outline yet. Put it on a node in the Outline view, or run "Novel Helper: Let the Model Find the Position on the Outline".', stem(target.at.chapter)),
			);
			return;
		}
		const moved = step(target.at.graph, target.at.position, direction);
		if (!moved) {
			void vscode.window.showInformationMessage(
				direction === 'forward' ? vscode.l10n.t('That is the last node of the outline.') : vscode.l10n.t('That is the first node of the outline.'),
			);
			return;
		}
		await this.place(target.at, moved, 'manual', target.text);
	}

	/** Has the model search the whole outline for where the chapter is, and says what came of it. */
	async relocate(): Promise<void> {
		const target = await this.target();
		if (!target) {
			return;
		}
		const name = stem(target.at.chapter);
		if (!target.text.slice(frontmatterLength(target.text)).trim()) {
			void vscode.window.showInformationMessage(vscode.l10n.t('{0} has no text yet to go by.', name));
			return;
		}
		const found = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Finding the position of {0} on the outline…', name) },
			() => this.search(target.at, target.text),
		);
		if (found) {
			const now = (await this.current())?.position;
			void vscode.window.showInformationMessage(
				vscode.l10n.t('{0} is {1}.', name, now ? describePosition(now.kind, now.nodes.map((node) => node.title)) : ''),
			);
		} else {
			void vscode.window.showWarningMessage(
				found === false
					? vscode.l10n.t('The model did not name a node of the outline: the position of {0} was not changed.', name)
					: vscode.l10n.t('The model could not be asked: check the API key and the output channel "Novel Helper". The position of {0} was not changed.', name),
			);
		}
	}

	/**
	 * After files were renamed or moved: a chapter's buoy file goes with the
	 * chapter (a folder of them with the folder), and the node ids in every
	 * buoy file follow the outline files they name.
	 */
	private async renamed(files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>): Promise<void> {
		const fs = vscode.workspace.fs;
		const exists = (uri: vscode.Uri) => fs.stat(uri).then(() => true, () => false);
		for (const index of await this.hooks.indexes.all()) {
			const renames = files.flatMap(({ oldUri, newUri }) => {
				const from = index.relative(oldUri);
				const to = index.relative(newUri);
				return from !== undefined && to !== undefined ? [{ from, to }] : [];
			});
			for (const { from, to } of renames) {
				// A chapter's file, or the folder for the chapters of a renamed volume.
				for (const suffix of ['.json', '']) {
					const source = index.uri(`${BUOY_FOLDER}/${from}${suffix}`);
					const target = index.uri(`${BUOY_FOLDER}/${to}${suffix}`);
					if ((await exists(source)) && !(await exists(target))) {
						await fs.createDirectory(vscode.Uri.joinPath(target, '..'));
						await fs.rename(source, target);
					}
				}
			}
			if (!renames.length) {
				continue;
			}
			const prefix = `${BUOY_FOLDER}/`;
			for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(index.storyUri, `${BUOY_FOLDER}/**/*.json`))) {
				const chapter = index.relative(uri)!.slice(prefix.length, -'.json'.length);
				const file = await this.readFile(index, chapter);
				if (!file) {
					continue;
				}
				const after: BuoyFile = { ...file, chapter, marks: file.marks.map((mark) => ({ ...mark, state: renameState(mark.state, renames) })) };
				if (serializeBuoyFile(after) !== serializeBuoyFile(file)) {
					await this.writeFile(index, after);
				}
			}
		}
		await this.follow();
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}

/** What a node is to a chapter: the node it is in, where a bridge comes from or goes to, one of two told at once. */
export function roleOf(at: ChapterPosition | undefined, node: OutlineNode): 'in' | 'from' | 'to' | 'parallel' | undefined {
	const place = at?.position?.nodes.indexOf(node) ?? -1;
	if (!at?.position || place === -1) {
		return undefined;
	}
	return at.position.kind === 'in' ? 'in' : at.position.kind === 'parallel' ? 'parallel' : place === 0 ? 'from' : 'to';
}

/** One line on where a chapter is, for the status bar and the outline view; undefined when it has no buoys. */
export function positionSummary(at: ChapterPosition | undefined): string | undefined {
	if (at?.position) {
		return describePosition(at.position.kind, at.position.nodes.map((node) => node.title));
	}
	const last = at?.file?.marks.at(-1);
	return at?.lost && last ? vscode.l10n.t('lost: {0} is no longer in the outline', last.state.nodes.map((node) => `【${node.title}】`).join(vscode.l10n.t(', '))) : undefined;
}
