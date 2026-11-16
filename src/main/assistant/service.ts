import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AgentClient, AgentFailure, agentCommand, type AgentCommand, type AgentHandlers, type SessionConfigOption } from '../../acp/client';
import { whereIs } from '../../acp/places';
import { editorContextBlock, revertNote, workspaceBrief, type EditorContext } from '../../core/assistantBrief';
import { allowOnce, decide, pathsOf } from '../../core/permission';
import type { StoryNames } from '../../core/scaffold';
import { titleOf, type Change, type SnapshotRecord } from '../../core/snapshot';
import { Transcript, type AskOption, type Item } from '../../core/transcript';
import { assistantUsageKey } from '../../core/usage';
import { SnapshotStore, type Blocked } from '../../storage/snapshotStore';
import type { UsageStore } from '../../storage/usageStore';
import type { Settings } from '../../shared/defaults';
import type { AssistantDiff, AssistantEvent, AssistantOption, AssistantOptionCategory, AssistantState } from '../../shared/assistant';
import type { StoredAgentOptions } from '../settings/store';
import { assistantMessages as m } from '../../renderer/strings';
import { atomicWrite, readOptional } from '../book/files';
import { bookPath } from '../book/paths';
import { prepareAgentEnvironment } from './environment';
import { agentError, readForAgent, writeTarget } from './files';

interface Saved {
	session?: { agent: string; id?: string };
	items: Item[];
	notes?: string[];
}
export interface AssistantOptions {
	root: string;
	userData: string;
	settings(): Settings;
	store?: SnapshotStore;
	usage?: UsageStore;
	beforeTurn?<T>(work: () => Promise<T>): Promise<T>;
	beforeHistory?(): Promise<void>;
	assistantOptions?(agent: string): StoredAgentOptions | undefined;
	selectAssistantOption?(agent: string, id: string, value: string, options?: AssistantOption[]): void;
	syncAssistantOptions?(agent: string, options: AssistantOption[]): void;
	names(): Promise<StoryNames>;
	environment?(): Promise<void>;
}

const categories: AssistantOptionCategory[] = ['model', 'thought_level'];
function extractOptions(configOptions: readonly SessionConfigOption[]): AssistantOption[] {
	return categories.flatMap((category) =>
		configOptions.flatMap((option) => {
			if (option.type !== 'select' || option.category !== category) {
				return [];
			}
			const values = option.options
				.flatMap((entry) => ('options' in entry ? entry.options : [entry]))
				.map(({ value, name, description }) => ({
					value,
					name,
					...(description ? { description } : {}),
				}));
			return values.length ? [{ id: option.id, name: option.name, category, value: option.currentValue, values }] : [];
		}),
	);
}

export class AssistantService {
	private transcript = new Transcript();
	private session?: Saved['session'];
	private client?: AgentClient;
	private clientAgent?: string;
	private briefPending = false;
	private notes: string[] = [];
	private busy = false;
	private probing = false;
	private status = '';
	private stopped = false;
	private disposed = false;
	private resetting = false;
	private starting?: AbortController;
	private connecting?: {
		agent: string;
		controller: AbortController;
		promise: Promise<{ client: AgentClient; names: StoryNames }>;
	};
	private probingTask?: Promise<boolean>;
	private running?: Promise<unknown>;
	private configuring: Promise<void> = Promise.resolve();
	private saving: Promise<void> = Promise.resolve();
	private lastOptions = '[]';
	private askCount = 0;
	private seenFiles = new Map<string, string>();
	private readonly probedAgents = new Set<string>();
	private readonly localAgentOptions = new Map<string, StoredAgentOptions>();
	private readonly asks = new Map<string, (allow?: boolean) => void>();
	private readonly listeners = new Set<(event: AssistantEvent) => void>();
	private readonly turnListeners = new Set<(changes: Change[]) => void>();
	private readonly revertListeners = new Set<(changes: Change[]) => void>();
	private readonly store: SnapshotStore;
	private readonly file: string;
	private readonly logFile: string;
	constructor(private readonly options: AssistantOptions) {
		const id = createHash('sha256').update(options.root).digest('hex');
		this.file = join(options.userData, 'assistant', `${id}.json`);
		this.logFile = join(options.userData, 'logs', `assistant-${id}.log`);
		this.store =
			options.store ??
			new SnapshotStore(
				options.root,
				options.userData,
				() => options.settings()['assistant.snapshots.keep'],
				() => options.settings()['snapshots.keep'],
			);
	}
	async load(): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		mkdirSync(dirname(this.logFile), { recursive: true });
		const text = await readOptional(this.file);
		if (text !== undefined) {
			const saved = JSON.parse(text) as Saved;
			this.session = saved.session;
			this.notes = saved.notes ?? [];
			this.transcript = new Transcript(saved.items);
			for (const item of this.transcript.items) {
				if (item.kind === 'ask' && !item.answer) {
					item.closed = true;
				}
				if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
					item.status = 'stopped';
				}
			}
		}
		this.lastOptions = JSON.stringify(this.currentOptions());
	}
	state(): AssistantState {
		const options = this.currentOptions();
		this.lastOptions = JSON.stringify(options);
		return {
			items: structuredClone(this.transcript.items),
			busy: this.busy,
			status: this.status,
			options,
			...(this.probing && { probing: true }),
		};
	}
	onChanged(listener: (event: AssistantEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	onTurnEnded(listener: (changes: Change[]) => void): () => void {
		this.turnListeners.add(listener);
		return () => {
			this.turnListeners.delete(listener);
		};
	}
	onReverted(listener: (changes: Change[]) => void): () => void {
		this.revertListeners.add(listener);
		return () => {
			this.revertListeners.delete(listener);
		};
	}
	refreshOptions(): void {
		const agent = this.currentAgent();
		if (!this.busy && this.connecting && this.connecting.agent !== agent) {
			this.connecting.controller.abort();
		}
		this.emitOptions();
	}
	private beforeTurn<T>(work: () => Promise<T>): Promise<T> {
		return this.options.beforeTurn ? this.options.beforeTurn(work) : work();
	}
	private getStored(agent: string): StoredAgentOptions | undefined {
		if (this.options.assistantOptions) {
			return this.options.assistantOptions(agent);
		}
		const stored = this.localAgentOptions.get(agent);
		return stored ? structuredClone(stored) : undefined;
	}
	private selectStored(agent: string, id: string, value: string, options?: AssistantOption[]): void {
		if (this.options.selectAssistantOption) {
			this.options.selectAssistantOption(agent, id, value, options);
			return;
		}
		const current = this.localAgentOptions.get(agent);
		const nextOptions = options ? structuredClone(options) : (current?.options ?? []);
		this.localAgentOptions.set(agent, { options: nextOptions, selected: { ...current?.selected, [id]: value } });
	}
	private syncStoredOptions(agent: string, options: AssistantOption[]): void {
		if (this.options.syncAssistantOptions) {
			this.options.syncAssistantOptions(agent, options);
			return;
		}
		const selected = { ...this.localAgentOptions.get(agent)?.selected };
		if (!options.length && !Object.keys(selected).length) {
			this.localAgentOptions.delete(agent);
		} else {
			this.localAgentOptions.set(agent, { options: structuredClone(options), selected });
		}
	}
	private currentCommand(): AgentCommand | undefined {
		const settings = this.options.settings();
		return agentCommand({
			agent: settings['assistant.agent'],
			command: settings['assistant.command'],
			args: settings['assistant.args'],
		});
	}
	private currentModelName(client: AgentClient): string {
		const modelOption = extractOptions(client.configOptions).find((option) => option.category === 'model');
		if (modelOption) {
			return modelOption.values.find((entry) => entry.value === modelOption.value)?.name ?? modelOption.value;
		}
		return this.options.settings()['assistant.agent'] === 'custom' ? 'custom' : 'Claude Code';
	}
	private currentAgent(): string | undefined {
		const command = this.currentCommand();
		return command ? JSON.stringify(command) : undefined;
	}
	private currentOptions(): AssistantOption[] {
		const agent = this.currentAgent();
		if (!agent) {
			return [];
		}
		if (this.client?.sessionId !== undefined && this.session?.agent === agent) {
			return extractOptions(this.client.configOptions);
		}
		const stored = this.getStored(agent);
		if (!stored) {
			return [];
		}
		return stored.options.map((option) => {
			const wanted = stored.selected[option.id];
			const value = wanted !== undefined && option.values.some((entry) => entry.value === wanted) ? wanted : option.value;
			return { ...option, value, values: option.values.map((entry) => ({ ...entry })) };
		});
	}
	private emitOptions(): void {
		if (this.disposed) {
			return;
		}
		const options = this.currentOptions();
		const next = JSON.stringify(options);
		if (next !== this.lastOptions) {
			this.lastOptions = next;
			this.emit({ type: 'options', options });
		}
	}
	private setProbing(probing: boolean): void {
		if (this.probing === probing) {
			return;
		}
		this.probing = probing;
		if (!this.disposed) {
			this.emit({ type: 'probing', probing });
		}
	}
	private syncLiveOptions(): void {
		if (!this.client || !this.session) {
			return;
		}
		this.syncStoredOptions(this.session.agent, extractOptions(this.client.configOptions));
		this.emitOptions();
	}
	private async restoreStoredOptions(agent: string, client: AgentClient): Promise<void> {
		for (const category of categories) {
			for (const option of extractOptions(client.configOptions)) {
				if (option.category !== category) {
					continue;
				}
				const wanted = this.getStored(agent)?.selected[option.id];
				if (wanted !== undefined && option.values.some((entry) => entry.value === wanted) && option.value !== wanted) {
					await client.setConfigOption(option.id, wanted);
				}
			}
		}
	}
	async probe(): Promise<boolean> {
		await this.configuring;
		if (this.busy || this.disposed || this.resetting) {
			return false;
		}
		const command = this.currentCommand();
		if (!command) {
			return false;
		}
		const agent = JSON.stringify(command);
		if (this.connecting?.agent === agent && this.probingTask) {
			return this.probingTask;
		}
		if (
			(this.client?.sessionId !== undefined && this.session?.agent === agent) ||
			(this.getStored(agent)?.options.length ?? 0) > 0 ||
			this.probedAgents.has(agent)
		) {
			return false;
		}
		this.setProbing(true);
		const { controller, promise } = this.connectShared(command);
		const task = promise
			.then(
				() => {
					this.probedAgents.add(agent);
					return (this.getStored(agent)?.options.length ?? 0) > 0;
				},
				() => {
					if (!controller.signal.aborted) {
						this.probedAgents.add(agent);
					}
					return false;
				},
			)
			.finally(() => {
				if (this.probingTask === task) {
					this.probingTask = undefined;
					this.setProbing(false);
				}
			});
		this.probingTask = task;
		return task;
	}
	async setOption(id: string, value: string): Promise<boolean> {
		if (this.busy || this.disposed || this.resetting) {
			return false;
		}
		const task = this.configuring.then(async () => {
			if (this.busy || this.disposed || this.resetting) {
				return false;
			}
			const agent = this.currentAgent();
			if (!agent) {
				return false;
			}
			const current = this.currentOptions().find((option) => option.id === id);
			if (!current || !current.values.some((entry) => entry.value === value)) {
				return false;
			}
			if (this.client?.sessionId !== undefined && this.session?.agent === agent) {
				await this.client.setConfigOption(id, value);
				const options = extractOptions(this.client.configOptions);
				const actual = options.find((option) => option.id === id)?.value ?? value;
				this.selectStored(agent, id, actual, options);
			} else {
				this.selectStored(agent, id, value);
			}
			this.emitOptions();
			return true;
		});
		this.configuring = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
	private changed(): void {
		this.emit({ type: 'state', state: this.state() });
	}
	private emit(event: AssistantEvent): void {
		this.listeners.forEach((listener) => listener(event));
	}
	private show(index: number): void {
		this.emit({ type: 'item', index, item: structuredClone(this.transcript.items[index]) });
	}
	private save(): Promise<void> {
		const saved: Saved = { session: this.session, items: this.transcript.kept(), notes: this.notes };
		const text = JSON.stringify(saved);
		this.saving = this.saving.then(() => atomicWrite(this.file, text));
		return this.saving;
	}
	private notice(level: 'info' | 'error', text: string, detail?: string): void {
		this.show(this.transcript.push({ kind: 'notice', level, text, detail }));
	}
	private setStatus(status: string): void {
		this.status = status;
		this.emit({ type: 'status', busy: this.busy, status });
	}
	private async exclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
		if (this.busy || this.disposed || this.resetting) {
			return;
		}
		this.busy = true;
		this.setStatus(this.status);
		const running = work().finally(async () => {
			await this.save();
			this.busy = false;
			this.setStatus('');
		});
		this.running = running;
		return running;
	}
	private ask(title: string, detail: string, options: AskOption[], signal?: AbortSignal): Promise<string | undefined> {
		if (this.stopped || this.disposed || signal?.aborted) {
			return Promise.resolve(undefined);
		}
		const id = String(++this.askCount);
		const item: Extract<Item, { kind: 'ask' }> = { kind: 'ask', id, title, detail, options };
		const index = this.transcript.push(item);
		return new Promise((resolve) => {
			const abort = () => this.asks.get(id)?.();
			this.asks.set(id, (allow) => {
				this.asks.delete(id);
				signal?.removeEventListener('abort', abort);
				const chosen = allow === undefined ? undefined : options.find((option) => option.kind === (allow ? 'allow_once' : 'reject_once'));
				if (chosen) {
					item.answer = chosen.name;
				} else {
					item.closed = true;
				}
				this.show(index);
				resolve(chosen?.id);
			});
			signal?.addEventListener('abort', abort);
			this.show(index);
		});
	}
	answer(id: string, allow: boolean): void {
		this.asks.get(id)?.(allow);
	}
	private async confirm(title: string, detail: string): Promise<boolean> {
		return (
			(await this.ask(title, detail, [
				{ id: 'allow', name: m.allow, kind: 'allow_once' },
				{ id: 'reject', name: m.reject, kind: 'reject_once' },
			])) === 'allow'
		);
	}
	private handlers(): Omit<AgentHandlers, 'closed'> {
		const root = this.options.root;
		const name = (file: string) => {
			const local = relative(root, resolve(root, file));
			return local && !local.startsWith('..') && !isAbsolute(local) ? local : file;
		};
		return {
			update: (update) => {
				if (update.sessionUpdate === 'config_option_update') {
					this.syncLiveOptions();
					return;
				}
				const index = this.transcript.apply(update, name);
				if (index !== undefined) {
					this.show(index);
				}
			},
			permission: async (request, signal) => {
				if (this.stopped || this.disposed || signal.aborted) {
					return undefined;
				}
				const call = request.toolCall;
				const files = pathsOf(call);
				const places = await Promise.all(files.map((file) => whereIs(root, file)));
				if (this.stopped || this.disposed || signal.aborted) {
					return undefined;
				}
				const allowed = decide(call.kind, places) === 'allow' ? allowOnce(request.options) : undefined;
				if (allowed !== undefined) {
					return allowed;
				}
				const said = (call.content ?? []).flatMap((content) =>
					content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [],
				);
				const options = request.options
					.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once')
					.map((option) => ({ id: option.optionId, name: option.kind === 'allow_once' ? m.allow : m.reject, kind: option.kind }));
				return this.ask(call.title ?? m.permission, [...said, ...files.map(name)].join('\n'), options, signal);
			},
			readFile: async (file) => {
				const full = await writeTarget(resolve(root, file));
				if (this.stopped || this.disposed || ((await whereIs(root, full)) === 'outside' && !(await this.confirm(m.readOutside, full)))) {
					throw await agentError(m.denied);
				}
				const text = await readForAgent(full);
				if (text === undefined) {
					throw await agentError(m.fileMissing);
				}
				this.seenFiles.set(full, this.hash(text));
				return text;
			},
			writeFile: async (file, content) => {
				const full = await writeTarget(resolve(root, file));
				if (this.stopped || this.disposed) {
					throw await agentError(m.denied);
				}
				const refuseChanged = async () => {
					const current = await readForAgent(full);
					if (current !== undefined && this.hash(current) !== this.seenFiles.get(full)) {
						throw await agentError(m.fileChanged);
					}
				};
				await refuseChanged();
				if ((await whereIs(root, full)) !== 'inside') {
					if (!(await this.confirm(m.writeUnkept, full))) {
						throw await agentError(m.denied);
					}
					// The file may have changed while the question was open.
					await refuseChanged();
				}
				await mkdir(dirname(full), { recursive: true });
				await atomicWrite(full, content);
				this.seenFiles.set(full, this.hash(content));
			},
			log: (text) => appendFileSync(this.logFile, `${new Date().toISOString()} ${text}\n`),
		};
	}
	private hash(text: string): string {
		return createHash('sha256').update(text).digest('hex');
	}
	private connectShared(command: AgentCommand): {
		controller: AbortController;
		promise: Promise<{ client: AgentClient; names: StoryNames }>;
	} {
		const agent = JSON.stringify(command);
		const previous = this.connecting;
		if (previous) {
			if (previous.agent === agent && !previous.controller.signal.aborted) {
				return { controller: previous.controller, promise: previous.promise };
			}
			previous.controller.abort();
		}
		const controller = new AbortController();
		const entry = {
			agent,
			controller,
			promise: (async () => {
				await previous?.promise.catch(() => undefined);
				if (controller.signal.aborted) {
					throw new Error(m.denied);
				}
				const names = await this.options.names();
				if (controller.signal.aborted) {
					throw new Error(m.denied);
				}
				const client = await this.connect(command, names, controller.signal);
				return { client, names };
			})().finally(() => {
				if (this.connecting === entry) {
					this.connecting = undefined;
				}
			}),
		};
		this.connecting = entry;
		return { controller, promise: entry.promise };
	}
	private async connect(command: AgentCommand, names: StoryNames, signal: AbortSignal): Promise<AgentClient> {
		const agent = JSON.stringify(command);
		if (this.session && this.session.agent !== agent) {
			const old = this.client;
			this.client = undefined;
			this.clientAgent = undefined;
			this.session = undefined;
			this.notes = [];
			this.transcript = new Transcript();
			this.changed();
			await old?.stop();
		} else if (this.client && this.clientAgent !== agent) {
			const old = this.client;
			this.client = undefined;
			this.clientAgent = undefined;
			await old.stop();
		}
		let client = this.client;
		if (!client) {
			await (this.options.environment ?? prepareAgentEnvironment)();
			if (signal.aborted) {
				throw new Error(m.denied);
			}
			let started: AgentClient | undefined;
			started = await AgentClient.start(
				command,
				this.options.root,
				{
					...this.handlers(),
					closed: (failure) => {
						if (started && this.client === started) {
							this.client = undefined;
							this.clientAgent = undefined;
							this.emitOptions();
							if (!this.busy && !this.disposed) {
								this.explain(failure, command, 'turn');
								void this.save();
							}
						}
					},
				},
				signal,
			);
			client = started;
		}
		if (client.sessionId === undefined) {
			const abort = () => {
				void client.stop();
			};
			signal.addEventListener('abort', abort, { once: true });
			try {
				if (signal.aborted) {
					throw new Error(m.denied);
				}
				const previous = this.session?.id;
				const { resumed, briefed } = await client.open(this.options.root, workspaceBrief(names), previous);
				if (signal.aborted) {
					throw new Error(m.denied);
				}
				await this.restoreStoredOptions(agent, client);
				if (signal.aborted) {
					throw new Error(m.denied);
				}
				this.client = client;
				this.clientAgent = agent;
				this.briefPending = !briefed;
				this.session = { agent, id: client.sessionId };
				this.probedAgents.add(agent);
				this.syncStoredOptions(agent, extractOptions(client.configOptions));
				this.emitOptions();
				await this.save();
				if (previous !== undefined && !resumed) {
					this.notice('info', m.newConversation);
				}
			} catch (error) {
				if (this.client === client) {
					this.client = undefined;
					this.clientAgent = undefined;
				}
				await client.stop();
				throw error;
			} finally {
				signal.removeEventListener('abort', abort);
			}
		}
		return client;
	}
	private explain(error: unknown, command: AgentCommand, during: 'start' | 'turn'): void {
		if (!(error instanceof AgentFailure)) {
			this.notice('error', m.failure(error instanceof Error ? error.message : String(error)));
			return;
		}
		const preset = this.options.settings()['assistant.agent'] !== 'custom';
		switch (error.kind) {
			case 'not-found':
				this.notice('error', preset ? m.npxMissing : m.commandMissing(command.command));
				break;
			case 'auth':
				this.notice('error', preset ? m.authClaude : m.authCustom, error.detail);
				break;
			case 'exited':
				this.notice('error', (during === 'start' ? m.exitedStart : m.exitedTurn)(error.exit ?? error.message), error.detail);
				break;
			default:
				this.notice('error', m.failure(error.message), error.detail);
		}
	}
	async send(text: string, context: Partial<EditorContext> = {}): Promise<boolean> {
		if (!text.trim()) {
			return false;
		}
		if (context.path !== undefined) {
			bookPath(context.path);
			if ((await whereIs(this.options.root, context.path)) === 'outside') {
				throw new Error(m.denied);
			}
		}
		return (await this.exclusive(() => this.run(text.trim(), context))) ?? false;
	}
	private async run(text: string, context: Partial<EditorContext>): Promise<boolean> {
		await this.configuring;
		this.stopped = false;
		const settings = this.options.settings();
		const command = this.currentCommand();
		if (!command) {
			this.notice('error', m.noCommand);
			return false;
		}
		const sameAgent = this.client && this.clientAgent === JSON.stringify(command);
		this.setStatus(sameAgent ? m.working : settings['assistant.agent'] === 'custom' ? m.starting : m.firstStart);
		const connection = this.connectShared(command);
		this.starting = connection.controller;
		const signal = connection.controller.signal;
		let client: AgentClient;
		let names: StoryNames;
		try {
			({ client, names } = await connection.promise);
		} catch (error) {
			if (!signal.aborted) {
				this.explain(error, command, 'start');
			}
			return false;
		} finally {
			this.starting = undefined;
		}
		if (this.stopped || this.disposed) {
			return false;
		}
		const record = await this.beforeTurn(async () =>
			this.stopped || this.disposed ? undefined : this.store.begin({ kind: 'turn', title: titleOf(text) }),
		);
		if (!record) {
			return false;
		}
		const root = await realpath(this.options.root);
		this.seenFiles = new Map(Object.entries(record.files).map(([path, hash]) => [resolve(root, path), hash]));
		const block = editorContextBlock({ ...context, notes: this.notes.splice(0) }, names.language);
		this.show(
			this.transcript.push({
				kind: 'user',
				text,
				context:
					context.path === undefined ? undefined : m.context(context.path, context.line, [...(context.selection?.text ?? '')].length),
			}),
		);
		await this.save();
		this.setStatus(m.working);
		let stop = 'failed';
		let turnUsage: Awaited<ReturnType<AgentClient['promptTurn']>>['usage'];
		let turnCost: number | undefined;
		try {
			if (this.stopped || this.disposed) {
				stop = 'cancelled';
			} else {
				const blocks = [...(this.briefPending ? [workspaceBrief(names)] : []), ...(block ? [block] : []), text];
				this.briefPending = false;
				const turn = await client.promptTurn(blocks);
				stop = turn.stopReason;
				turnUsage = turn.usage;
				turnCost = turn.cost;
			}
		} catch (error) {
			if (this.disposed) {
				stop = 'cancelled';
			} else {
				this.explain(error, command, 'turn');
			}
		}
		if (stop !== 'refusal' && (turnUsage || turnCost !== undefined)) {
			await this.options.usage?.add(assistantUsageKey(this.currentModelName(client)), turnUsage ?? { input: 0, output: 0 }, turnCost);
		}
		for (const settle of this.asks.values()) {
			settle();
		}
		const changes = await this.store.finish(record.id);
		this.transcript
			.endTurn({ kind: 'turn', ...(changes.length && { record: record.id }), stop, changes })
			.forEach((index) => this.show(index));
		this.turnListeners.forEach((listener) => listener(changes));
		return true;
	}
	stop(): void {
		this.stopped = true;
		for (const settle of this.asks.values()) {
			settle();
		}
		if (this.starting) {
			this.starting.abort();
			void this.client?.stop();
			this.client = undefined;
			this.clientAgent = undefined;
			this.emitOptions();
		} else if (this.busy) {
			void this.client?.cancel();
		}
	}
	async newSession(): Promise<void> {
		if (this.resetting || this.disposed) {
			return;
		}
		this.resetting = true;
		try {
			this.stop();
			this.connecting?.controller.abort();
			await this.probingTask;
			await this.running;
			await this.configuring;
			await this.client?.close();
			this.session = undefined;
			this.notes = [];
			this.transcript = new Transcript();
			await this.save();
			this.changed();
		} finally {
			this.resetting = false;
		}
	}
	async history(): Promise<SnapshotRecord[]> {
		await this.options.beforeHistory?.();
		return this.store.list();
	}
	private validRecord(id: number): void {
		if (!Number.isSafeInteger(id) || id < 1) {
			throw new Error(m.invalidRecord);
		}
	}
	async diff(id: number, path: string): Promise<AssistantDiff> {
		this.validRecord(id);
		bookPath(path);
		const record = await this.store.get(id);
		const change = record?.changes?.find((change) => change.path === path);
		if (!change) {
			throw new Error(m.expired);
		}
		const text = async (hash?: string) => (hash ? new TextDecoder('utf-8').decode(await this.store.read(hash)) : '');
		const canOpen =
			change.after !== undefined &&
			(await whereIs(this.options.root, path)) !== 'outside' &&
			(await this.store.hashOf(path)) === change.after;
		return {
			path,
			before: await text(change.before),
			after: await text(change.after),
			canOpen,
			...((record?.kind === 'timed' || record?.kind === 'conflict') && { timed: true }),
		};
	}
	async revert(id: number): Promise<{ blocked: Blocked[] }> {
		this.validRecord(id);
		return (
			(await this.exclusive(async () => {
				this.setStatus(m.reverting);
				const outcome = await this.beforeTurn(async () => {
					const target = await this.store.get(id);
					const plan = target ? await this.store.preview(id) : undefined;
					if (!target || !plan) {
						throw new Error(m.expired);
					}
					if (plan.blocked.length) {
						return { target, blocked: plan.blocked, noop: false };
					}
					if (!plan.write.length && !plan.remove.length) {
						return { target, blocked: [] as Blocked[], noop: true };
					}
					const { record, blocked } = await this.store.revert(id);
					return { target, record, blocked, noop: false };
				});
				if (outcome.noop) {
					this.notice('info', outcome.target.kind === 'timed' || outcome.target.kind === 'conflict' ? m.noSnapshotRevert : m.noRevert);
					return { blocked: [] };
				}
				const { target, record, blocked } = outcome;
				if (record?.changes && !blocked.length) {
					this.transcript.push({
						kind: 'turn',
						record: record.id,
						stop: 'reverted',
						...((target.kind === 'turn' || target.kind === 'revert') && { target: id }),
						changes: record.changes,
					});
					this.notes.push(
						revertNote(
							record.changes.map((change) => change.path),
							(await this.options.names()).language,
						),
					);
					this.revertListeners.forEach((listener) => listener(record.changes!));
					this.changed();
				}
				return { blocked };
			})) ?? { blocked: [] }
		);
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		this.stop();
		this.connecting?.controller.abort();
		const old = this.client;
		this.client = undefined;
		this.clientAgent = undefined;
		await old?.stop();
		await this.probingTask;
		await this.running;
		await this.configuring;
		await this.save();
		this.listeners.clear();
		this.turnListeners.clear();
		this.revertListeners.clear();
	}
}
