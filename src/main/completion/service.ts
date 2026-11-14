import { Buoys } from '../buoys/service';
import { positionSource } from '../../core/buoy';
import { renderReport, renderUsage, type RunRecord } from '../../core/report';
import { translateReport } from '../../renderer/strings';
import type { ReportKind } from '../../shared/api';
import { buildContext } from '../../core/context';
import { buildHttpRequest, complete } from '../../llm/client';
import { costOf, ratesFor, usageKey } from '../../core/usage';
import type { SettingsStore } from '../settings/store';
import type { BookIndex } from '../book/indexer';
import type { UsageStore } from '../../storage/usageStore';
import type { CompletionInput, CompletionResult, UsageStatus } from '../../shared/api';
import type { ProviderId } from '../../llm/providers';
import { LINE_END_REST } from '../../shared/completion';
export class CompletionService {
	private positions = new Map<string, Buoys>();
	private runs = new Map<string, RunRecord>();
	onPositionChanged: (root: string) => void = () => {};
	onReportChanged: () => void = () => {};
	beforeWrite: <T>(root: string, work: () => Promise<T>) => Promise<T> = (_root, work) => work();
	private running = new Map<string, AbortController>();
	private lastShown = new Map<string, { key: string; text: string }>();
	private active = 0;
	private closed = new Map<string, Promise<void>>();
	private writes = new Set<Promise<void>>();
	private problem?: string;
	private missingKey = false;
	onChanged: (status: UsageStatus) => void = () => {};
	buoys(index: BookIndex): Buoys {
		let service = this.positions.get(index.root);
		if (!service) {
			service = new Buoys(index, this.settings, this.usage, this.getKey);
			service.beforeWrite = (work) => this.beforeWrite(index.root, work);
			service.onChanged = () => this.onPositionChanged(index.root);
			service.onError = (error) => {
				this.problem = String(error);
				this.publish();
			};
			this.positions.set(index.root, service);
		}
		return service;
	}
	closeBook(root: string): void {
		this.positions.get(root)?.dispose();
		this.positions.delete(root);
	}
	async report(owner: string, kind: ReportKind): Promise<string> {
		if (kind === 'report') {
			return renderReport(this.runs.get(owner), translateReport);
		}
		const ledger = await this.usage.load();
		const model = this.settings.model();
		return renderUsage(
			ledger,
			new Date(),
			{
				dailyLimit: this.settings.get()['usage.dailyLimitUsd'],
				current: `${model.provider} · ${model.model}`,
				rates: ratesFor(model.model, new Date(), model.pricing, this.settings.prices()),
			},
			translateReport,
		);
	}
	constructor(
		readonly settings: SettingsStore,
		readonly usage: UsageStore,
		private readonly getKey: (provider: ProviderId) => string | undefined,
	) {
		let ledger = JSON.stringify(usage.current());
		usage.onDidChange(() => {
			this.publish();
			const current = JSON.stringify(usage.current());
			if (current !== ledger) {
				ledger = current;
				this.onReportChanged();
			}
		});
	}
	status(): UsageStatus {
		const model = this.settings.model();
		return {
			state: !this.settings.get().enabled
				? 'off'
				: this.active
					? 'requesting'
					: this.problem
						? 'problem'
						: this.usage.overLimit(this.settings.get()['usage.dailyLimitUsd'])
							? 'limit'
							: 'on',
			problem: this.problem,
			missingKey: this.missingKey,
			priced: ratesFor(model.model, new Date(), model.pricing, this.settings.prices()) !== undefined,
			today: this.usage.today(),
		};
	}
	publish(): void {
		this.onChanged(this.status());
	}
	settingsChanged(): void {
		this.problem = undefined;
		this.missingKey = false;
		this.lastShown.clear();
		this.positions.forEach((service) => service.cancel());
		for (const controller of this.running.values()) {
			controller.abort();
		}
		this.publish();
	}
	cancel(owner: string, id?: number): void {
		for (const [key, controller] of this.running) {
			if (id === undefined ? key.startsWith(`${owner}:`) : key === `${owner}:${id}`) {
				controller.abort();
			}
		}
	}
	async drain(owner?: string): Promise<void> {
		if (owner) {
			this.cancel(owner);
		} else {
			for (const controller of this.running.values()) {
				controller.abort();
			}
		}
		await Promise.all([...this.closed].filter(([key]) => !owner || key.startsWith(`${owner}:`)).map(([, done]) => done));
		await Promise.all(this.writes);
	}
	async request(owner: string, index: BookIndex, input: CompletionInput): Promise<CompletionResult> {
		const c = this.settings.get();
		const before = input.text.slice(0, input.offset);
		const after = input.text.slice(input.offset);
		const lineAfter = after.split('\n', 1)[0];
		if (
			!c.enabled ||
			!/\.(md|txt)$/.test(input.path) ||
			(!input.manual && (c.trigger === 'manual' || !index.library.isChapter(input.path) || !LINE_END_REST.test(lineAfter)))
		) {
			return { status: 'skipped' };
		}
		if (!input.manual && this.usage.overLimit(c['usage.dailyLimitUsd'])) {
			this.publish();
			return { status: 'skipped' };
		}
		const requestId = `${owner}:${input.id}`;
		const controller = new AbortController();
		this.running.set(requestId, controller);
		let resolveClosed!: () => void;
		this.closed.set(
			requestId,
			new Promise((resolve) => {
				resolveClosed = resolve;
			}),
		);
		const finish = () => {
			if (this.running.get(requestId) === controller) {
				this.running.delete(requestId);
			}
			this.closed.delete(requestId);
			resolveClosed();
		};
		let requesting = false;
		try {
			const model = this.settings.model();
			const apiKey = this.getKey(model.provider);
			if (model.keyRequired && !apiKey) {
				this.problem = 'missingKey';
				this.missingKey = true;
				this.publish();
				finish();
				return { status: 'error', error: 'missingKey' };
			}
			const limits = this.settings.limits();
			const library = index.library;
			const read = async (path: string) => (await index.read(path)).text;
			const at = library.isChapter(input.path) ? await this.buoys(index).prepare(input.path, input.text) : undefined;
			const outlinePath = at?.position ? undefined : library.companionOf('outline', input.path);
			const [levels, outline, previous] = await Promise.all([
				Promise.all(
					library
						.levelsOf(input.path)
						.filter((level) => !at?.position || level.path === '')
						.map(async (level) => ({
							name: level.name,
							book: level.path === '',
							outline: level.outline ? await index.outlineSource(level.outline) : undefined,
						})),
				),
				outlinePath ? index.outlineSource(outlinePath) : undefined,
				Promise.all(
					library.previousChapters(input.path, limits.previousChapters).map(async (path) => {
						const summary = library.companionOf('summary', path);
						const content = summary ? await read(summary) : '';
						return content.trim() ? { path, summary: content } : { path, text: await read(path) };
					}),
				),
			]);
			await this.usage.load();
			if (controller.signal.aborted || !this.settings.get().enabled) {
				finish();
				return { status: 'cancelled' };
			}
			if (!input.manual && this.usage.overLimit(this.settings.get()['usage.dailyLimitUsd'])) {
				finish();
				this.publish();
				return { status: 'skipped' };
			}
			const { prompt, trace } = buildContext({
				documentPath: input.path,
				before,
				after,
				maxChars: c.maxSuggestionChars,
				entries: library.entries(),
				matcher: library.matcher(),
				levels,
				outline,
				previous,
				position: at?.position && positionSource(at.graph, at.position),
				limits,
			});
			const request = { ...model, apiKey, ...prompt };
			const { url, body } = buildHttpRequest(request);
			const key = JSON.stringify([url, body, c.maxSuggestionChars]);
			const cached = this.lastShown.get(owner);
			if (!input.manual && cached?.key === key) {
				finish();
				return { status: 'ok', text: cached.text };
			}
			const rates = ratesFor(model.model, new Date(), model.pricing, this.settings.prices());
			const run: RunRecord = {
				time: new Date(),
				document: input.path,
				line: before.split('\n').length,
				trigger: input.manual ? 'manual' : 'auto',
				provider: model.provider,
				model: model.model,
				trace,
				prompt,
				request: { url, body },
				rates,
			};
			if (at) {
				this.buoys(index).update(at, input.text);
			}
			this.active++;
			requesting = true;
			this.problem = undefined;
			this.missingKey = false;
			this.publish();
			const outcome = await complete(request, {
				signal: controller.signal,
				before,
				after: lineAfter,
				maxChars: c.maxSuggestionChars,
				onUsage: (usage) => {
					run.usage = usage;
					this.onReportChanged();
					const write = this.usage.add(usageKey(model.provider, model.model), usage, rates ? costOf(usage, rates) : undefined);
					this.writes.add(write);
					void write.then(
						() => this.writes.delete(write),
						(error) => {
							this.writes.delete(write);
							this.problem = String(error);
							this.publish();
						},
					);
				},
				onClose: finish,
			});
			this.active--;
			requesting = false;
			this.problem = outcome.status === 'error' ? outcome.error : undefined;
			this.publish();
			if (controller.signal.aborted || outcome.status === 'cancelled') {
				return { status: 'cancelled' };
			}
			run.outcome = outcome;
			this.runs.set(owner, run);
			this.onReportChanged();
			if (outcome.status !== 'ok') {
				return { status: 'error', error: outcome.error };
			}
			this.lastShown.set(owner, { key, text: outcome.text });
			return { status: 'ok', text: outcome.text };
		} catch (error) {
			if (requesting) {
				this.active--;
			}
			finish();
			this.problem = String(error);
			this.publish();
			return { status: 'error', error: this.problem };
		}
	}
}
