// The assistant: a conversation in the sidebar with an agent that works on
// the whole story. The agent is a process of its own that speaks ACP (see
// acp/client.ts); this file is what holds a conversation together: which
// story folder it is about, what the agent is told, what it may do without
// asking, the snapshot around every turn, and the panel that shows it all.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type AgentCommand, agentCommand, AgentClient, AgentFailure, type AgentHandlers } from '../acp/client';
import { whereIs } from '../acp/places';
import { type EditorContext, editorContextBlock, editorContextLabel, revertNote, workspaceBrief } from '../core/assistantBrief';
import { allowOnce, decide, pathsOf } from '../core/permission';
import type { StoryNames } from '../core/scaffold';
import { type Change, changeKind, titleOf } from '../core/snapshot';
import { isUsable, leadsOut } from '../core/story';
import { type AskOption, type Item, Transcript } from '../core/transcript';
import { type Blocked, SnapshotStore } from '../storage/snapshotStore';
import { assistantSettings } from './config';
import { markerOfIndex } from './story';
import { type FolderIndex, readText, type WorkspaceIndexes } from './workspaceIndex';

export const ASSISTANT_VIEW = 'novelHelper.assistant';
/** Documents of this scheme show a file as a snapshot has it; the query says which story folder and which content. */
const SNAPSHOT_SCHEME = 'novel-helper-snapshot';
const STATE_KEY = 'novelHelper.assistant';

/** What a conversation is with: the story folder (its path on disk), the agent's command line, and the agent's id for the session once it has one. */
interface Session {
	story: string;
	agent: string;
	id?: string;
}

/** Kept in the workspace's state, so that a window that is opened again shows the conversation and can go on with it. */
interface Saved {
	session?: Session;
	items: Item[];
}

/** The names of the story's folders, for the brief: the ones in use, else the ones it was set up with, else the first of the settings. */
function storyNames(index: FolderIndex): StoryNames {
	const used = markerOfIndex(index);
	const made = index.marker?.folders?.lore ?? [];
	const lore = used.folders!.lore!.length ? used.folders!.lore! : made.length ? made : index.folders('lore').slice(0, 1);
	return {
		language: index.marker?.language ?? used.language!,
		chapters: used.folders!.chapters!,
		outlines: used.folders!.outlines!,
		summaries: used.folders!.summaries!,
		lore,
		book: used.book!,
	};
}

/** Saves the files of the story folder that have unsaved changes: the agent reads the disk, and so does the snapshot. */
async function saveUnsaved(index: FolderIndex): Promise<void> {
	for (const document of vscode.workspace.textDocuments) {
		if (document.isDirty && index.relative(document.uri) !== undefined) {
			await document.save();
		}
	}
}

function summary(changes: readonly Change[]): string {
	const count = (kind: ReturnType<typeof changeKind>) => changes.filter((change) => changeKind(change) === kind).length;
	return vscode.l10n.t('{0} changed, {1} new, {2} deleted', count('modified'), count('added'), count('removed'));
}

/** The text the panel shows; the page itself holds none. Where the page fills in a number or a name, the placeholder is handed through. */
function strings(): Record<string, string> {
	const t = vscode.l10n.t;
	return {
		placeholder: t('Ask about the story, or say what to change. Enter sends, Shift+Enter starts a new line.'),
		send: t('Send'),
		stop: t('Stop'),
		empty: t('The assistant reads and changes the files of the story folder: chapters, outlines, lore. A snapshot is taken before every turn, so each turn can be looked at and gone back from.'),
		thought: t('Thinking'),
		plan: t('Plan'),
		pending: t('waiting'),
		in_progress: t('running'),
		completed: t('done'),
		failed: t('failed'),
		stopped: t('stopped'),
		askClosed: t('Not allowed: nobody answered.'),
		askAnswered: t('Answered: {0}', '{0}'),
		changed: t('This turn changed {0} files', '{0}'),
		unchanged: t('This turn changed no files.'),
		reverted: t('Went back to before #{0}', '{0}'),
		revert: t('Go Back to Before This Turn'),
		undoRevert: t('Undo This Going Back'),
		added: t('new'),
		removed: t('deleted'),
		modified: t('changed'),
		cancelled: t('Stopped.'),
		refusal: t('The agent refused to go on.'),
		max_tokens: t('The agent ran out of output and stopped.'),
		max_turn_requests: t('The agent reached its limit of steps and stopped.'),
		failedTurn: t('The turn broke off.'),
	};
}

export class AssistantView implements vscode.WebviewViewProvider, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private view?: vscode.WebviewView;
	private transcript: Transcript;
	private session?: Session;
	private client?: AgentClient;
	/** The workspace brief still has to go out, in front of the next message: the agent took no system prompt. */
	private briefPending = false;
	/** What the agent is to be told with the next message. */
	private notes: string[] = [];
	private busy = false;
	private status = '';
	/** Set while the agent is being started; aborting it gives the start up. */
	private starting?: AbortController;
	/** The writer pressed stop during this turn. */
	private stopped = false;
	/** The turn, or the going back, that is under way. */
	private running?: Promise<void>;
	private readonly asks = new Map<string, (option?: string) => void>();
	private askCount = 0;
	private contextTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly indexes: WorkspaceIndexes,
		private readonly log: vscode.LogOutputChannel,
		/** Called after files of a story folder were changed from here: by a turn, or by going back. */
		private readonly filesChanged: () => void,
	) {
		const saved = context.workspaceState.get<Saved>(STATE_KEY);
		this.session = saved?.session;
		this.transcript = new Transcript(saved?.items ?? []);
		const contextChanged = () => {
			clearTimeout(this.contextTimer);
			this.contextTimer = setTimeout(() => void this.showContext(), 150);
		};
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(ASSISTANT_VIEW, this),
			vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
				provideTextDocumentContent: async (uri) => {
					const { story, hash } = JSON.parse(uri.query) as { story: string; hash: string };
					return hash ? new TextDecoder('utf-8').decode(await this.storeOf(story).read(hash)) : '';
				},
			}),
			vscode.commands.registerCommand('novelHelper.assistant.newSession', () => this.newSession()),
			vscode.commands.registerCommand('novelHelper.assistant.history', () => this.history()),
			vscode.window.onDidChangeActiveTextEditor(contextChanged),
			vscode.window.onDidChangeTextEditorSelection(contextChanged),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const roots = ['dist', 'media'].map((folder) => vscode.Uri.joinPath(this.context.extensionUri, folder));
		view.webview.options = { enableScripts: true, localResourceRoots: roots };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((message: { type: string; [key: string]: unknown }) => this.receive(message));
		view.onDidDispose(() => (this.view = undefined));
	}

	/**
	 * The page: one script and one style sheet of the extension, and nothing
	 * else. No inline script or style, no pictures, no connection anywhere;
	 * what the agent writes gets into the page as text only.
	 */
	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'assistant.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'assistant.css'));
		return [
			'<!DOCTYPE html>',
			`<html lang="${vscode.env.language}">`,
			'<head>',
			'<meta charset="UTF-8">',
			`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
			'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
			`<link rel="stylesheet" href="${style}">`,
			'</head>',
			'<body>',
			'<main id="log"></main>',
			'<footer>',
			'<div id="status" hidden></div>',
			'<div id="context" hidden></div>',
			'<textarea id="input" rows="3"></textarea>',
			'<div id="buttons"><button id="stop" class="secondary" hidden></button><button id="send"></button></div>',
			'</footer>',
			`<script nonce="${nonce}" src="${script}"></script>`,
			'</body>',
			'</html>',
		].join('\n');
	}

	private post(message: { type: string; [key: string]: unknown }): void {
		void this.view?.webview.postMessage(message);
	}

	/** Shows the item at `at` as it is now. */
	private show(at: number): void {
		this.post({ type: 'item', index: at, item: this.transcript.items[at] });
	}

	private showAll(): void {
		this.post({ type: 'init', strings: strings(), items: this.transcript.items, busy: this.busy, status: this.status });
		void this.showContext();
	}

	private setBusy(busy: boolean, status = ''): void {
		this.busy = busy;
		this.status = status;
		this.post({ type: 'state', busy, status });
	}

	private notice(level: 'info' | 'error', text: string, detail?: string): void {
		this.show(this.transcript.push({ kind: 'notice', level, text, ...(detail && { detail }) }));
	}

	private receive(message: { type: string; [key: string]: unknown }): void {
		switch (message.type) {
			case 'ready':
				this.showAll();
				break;
			case 'send':
				void this.send(String(message.text));
				break;
			case 'stop':
				this.stop();
				break;
			case 'answer':
				this.asks.get(String(message.id))?.(String(message.option));
				break;
			case 'diff':
				void this.openDiff(Number(message.record), String(message.path));
				break;
			case 'revert':
				void this.revert(Number(message.record));
				break;
			case 'link':
				// The page only makes links of web addresses; checked again here, where it counts.
				if (/^(https?:\/\/|mailto:)/i.test(String(message.href))) {
					void vscode.env.openExternal(vscode.Uri.parse(String(message.href)));
				}
				break;
		}
	}

	private async save(): Promise<void> {
		const saved: Saved = { session: this.session, items: this.transcript.kept() };
		await this.context.workspaceState.update(STATE_KEY, saved);
	}

	private storeOf(story: string): SnapshotStore {
		return new SnapshotStore(story, () => assistantSettings().keepSnapshots);
	}

	/** The story folder to work in: the one of the conversation, else the one the open file is in, else the first that can be used. */
	private async target(): Promise<FolderIndex | undefined> {
		const usable = (await this.indexes.all()).filter((index) => isUsable(index.state));
		const editor = vscode.window.activeTextEditor;
		const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
		return usable.find((index) => index.storyUri.fsPath === this.session?.story) ?? usable.find((index) => index.folder === folder) ?? usable[0];
	}

	/** What the writer has open in a story folder, and what is selected there. */
	private editorContext(index: FolderIndex): Partial<EditorContext> {
		const editor = vscode.window.activeTextEditor;
		const file = editor?.document.uri.scheme === 'file' ? index.relative(editor.document.uri) : undefined;
		if (!editor || file === undefined) {
			return {};
		}
		const { selection, document } = editor;
		return {
			path: file,
			line: selection.active.line + 1,
			...(!selection.isEmpty && {
				selection: {
					text: document.getText(selection),
					startLine: selection.start.line + 1,
					startColumn: selection.start.character + 1,
					endLine: selection.end.line + 1,
					endColumn: selection.end.character + 1,
				},
			}),
		};
	}

	private contextText(context: Partial<EditorContext>): string {
		const label = editorContextLabel(context);
		if (!label) {
			return '';
		}
		return label.selected ? vscode.l10n.t('{0} · {1} characters selected', label.file, label.selected) : label.file;
	}

	/** Says on the panel what the next message will take along. */
	private async showContext(): Promise<void> {
		if (this.view) {
			const index = await this.target();
			this.post({ type: 'context', text: index ? this.contextText(this.editorContext(index)) : '' });
		}
	}

	/** Puts a question of the agent on the panel. Resolves to the option the writer picks; to undefined when the turn ends first or the agent stops waiting. */
	private ask(title: string, detail: string, options: AskOption[], signal?: AbortSignal): Promise<string | undefined> {
		const id = String(++this.askCount);
		const at = this.transcript.push({ kind: 'ask', id, title, detail, options });
		this.show(at);
		return new Promise((resolve) => {
			const settle = (option?: string) => {
				this.asks.delete(id);
				const item = this.transcript.items[at] as Extract<Item, { kind: 'ask' }>;
				const chosen = options.find((one) => one.id === option);
				if (chosen) {
					item.answer = chosen.name;
				} else {
					item.closed = true;
				}
				this.show(at);
				resolve(chosen?.id);
			};
			this.asks.set(id, settle);
			signal?.addEventListener('abort', () => this.asks.get(id)?.());
		});
	}

	/** A yes-or-no question of the extension's own, about something the agent wants through the client. */
	private async confirm(title: string, detail: string): Promise<boolean> {
		const options = [
			{ id: 'allow', name: vscode.l10n.t('Allow Once'), kind: 'allow_once' },
			{ id: 'reject', name: vscode.l10n.t('Do Not Allow'), kind: 'reject_once' },
		];
		return (await this.ask(title, detail, options)) === 'allow';
	}

	private handlers(story: string): Omit<AgentHandlers, 'closed'> {
		const t = vscode.l10n.t;
		/** Inside the story folder a path is shown relative to it. */
		const name = (file: string) => {
			const relative = path.relative(story, path.resolve(story, file));
			return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
		};
		return {
			update: (update) => {
				const at = this.transcript.apply(update, name);
				if (at !== undefined) {
					this.show(at);
				}
			},
			// Reading and changing the story's files goes through; a command, the network or a path outside is put to the writer.
			permission: async (request, signal) => {
				const call = request.toolCall;
				const files = pathsOf(call);
				const places = await Promise.all(files.map((file) => whereIs(story, file)));
				const allowed = decide(call.kind, places) === 'allow' ? allowOnce(request.options) : undefined;
				if (allowed !== undefined) {
					return allowed;
				}
				const said = (call.content ?? []).flatMap((content) => (content.type === 'content' && content.content.type === 'text' ? [content.content.text] : []));
				// Yes or no to this one request. What an agent offers beyond that ("always allow") is not shown: an answer
				// that stands for later requests would let those past the rules above.
				const options = request.options
					.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once')
					.map((option) => ({ id: option.optionId, name: option.kind === 'allow_once' ? t('Allow Once') : t('Do Not Allow'), kind: option.kind }));
				return this.ask(call.title ?? t('The agent asks for permission'), [...said, ...files.map(name)].join('\n'), options, signal);
			},
			readFile: async (file) => {
				const full = path.resolve(story, file);
				if ((await whereIs(story, file)) === 'outside' && !(await this.confirm(t('Read a file outside the story folder'), full))) {
					throw new Error('The writer did not allow reading this file: it is outside the story folder.');
				}
				// The editor's copy if the file is open: what the writer sees, saved or not.
				return readText(vscode.Uri.file(full));
			},
			writeFile: async (file, content) => {
				const full = path.resolve(story, file);
				if ((await whereIs(story, file)) !== 'inside' && !(await this.confirm(t('Write a file that snapshots do not keep'), full))) {
					throw new Error('The writer did not allow writing this file.');
				}
				await fs.mkdir(path.dirname(full), { recursive: true });
				await fs.writeFile(full, content);
			},
			log: (text) => this.log.info(`[agent] ${text}`),
		};
	}

	/** The agent, started if it is not running, with a session open in this story folder: the earlier one if the agent still has it. */
	private async connect(index: FolderIndex, command: AgentCommand, signal: AbortSignal): Promise<AgentClient> {
		const story = index.storyUri.fsPath;
		const agent = [command.command, ...command.args].join(' ');
		if (this.session && (this.session.story !== story || this.session.agent !== agent)) {
			// Another story folder, or another agent: what was said so far was not said to this one.
			this.client?.stop();
			this.client = undefined;
			this.session = undefined;
			this.transcript = new Transcript();
			this.showAll();
		}
		if (!this.client) {
			let started: AgentClient | undefined;
			const closed = (failure: AgentFailure) => {
				this.log.warn(`[agent] ${failure.message}`);
				if (started && this.client === started) {
					this.client = undefined;
				}
			};
			started = await AgentClient.start(command, story, { ...this.handlers(story), closed }, signal);
			this.client = started;
		}
		const client = this.client;
		if (client.sessionId === undefined) {
			const previous = this.session?.id;
			const { resumed, briefed } = await client.open(story, workspaceBrief(storyNames(index)), previous);
			this.briefPending = !briefed;
			this.session = { story, agent, id: client.sessionId };
			if (previous !== undefined && !resumed) {
				this.notice('info', vscode.l10n.t('The earlier conversation could not be picked up, so this is a new one: the agent does not remember what is above.'));
			}
		}
		return client;
	}

	/** Why the agent could not be used, and what to do about it. */
	private explain(failure: unknown, command: AgentCommand, during: 'start' | 'turn'): void {
		const t = vscode.l10n.t;
		const preset = assistantSettings().agent !== 'custom';
		if (!(failure instanceof AgentFailure)) {
			this.notice('error', t('The assistant ran into an error: {0}', failure instanceof Error ? failure.message : String(failure)));
			return;
		}
		switch (failure.kind) {
			case 'not-found':
				this.notice(
					'error',
					preset
						? t('Could not start the agent: "npx" was not found. The Claude adapter is started through Node.js (22 or later). Install Node.js and start VS Code again; if Node.js is installed and VS Code does not see it, start VS Code from a terminal.')
						: t('Could not start the agent: the command "{0}" was not found. Check novelHelper.assistant.command; a full path always works.', command.command),
				);
				break;
			case 'auth':
				this.notice(
					'error',
					preset
						? t('Claude Code is not logged in on this machine. Open a terminal, run "claude", log in there, then send the message again. The assistant uses that login; it needs no API key and takes none from this extension.')
						: t('The agent is not logged in. Log in with the agent\'s own command line, then send the message again.'),
					failure.detail,
				);
				break;
			case 'exited': {
				const how = failure.exit === undefined ? failure.message : t('exit code {0}', failure.exit);
				this.notice(
					'error',
					during === 'start'
						? preset
							? t('The agent ended as soon as it was started ({0}). What it wrote last is below. The first start downloads the Claude adapter, which needs the network and Node.js 22 or later.', how)
							: t('The agent ended as soon as it was started ({0}). What it wrote last is below. Check novelHelper.assistant.command and novelHelper.assistant.args.', how)
						: t('The agent ended in the middle of the turn ({0}). Send a message to start it again; the conversation is picked up where the agent can do that.', how),
					failure.detail,
				);
				break;
			}
			default:
				this.notice('error', t('The agent answered with an error: {0}', failure.message), failure.detail);
		}
	}

	/** Why nothing was sent; the message goes back into the input box. */
	private refuse(text: string, reason: string): void {
		this.notice('error', reason);
		this.post({ type: 'draft', text });
	}

	/** One turn: a snapshot, the message with what the editor shows, the agent's work, and what it changed. */
	async send(message: string): Promise<void> {
		const text = message.trim();
		if (text) {
			await this.exclusive(() => this.run(text));
		}
	}

	/**
	 * The one way in for a turn and for going back: whichever comes first has
	 * the panel until it is over, and what comes meanwhile is dropped. The
	 * panel is taken before anything is waited for, so nothing gets in between.
	 */
	private async exclusive(work: () => Promise<void>): Promise<void> {
		if (this.busy) {
			return;
		}
		// The work says on the panel what it is doing, once it knows.
		this.busy = true;
		this.running = work().finally(() => this.setBusy(false));
		await this.running;
	}

	private async run(text: string): Promise<void> {
		const t = vscode.l10n.t;
		if (!vscode.workspace.isTrusted) {
			this.refuse(text, t('The assistant is off in Restricted Mode: an agent acts on what it reads in the folder. Trust the folder to use it.'));
			return;
		}
		const command = agentCommand(assistantSettings());
		if (!command) {
			this.refuse(text, t('The custom agent has no command. Set novelHelper.assistant.command (and novelHelper.assistant.args) in your user settings.'));
			return;
		}
		const starting =
			assistantSettings().agent === 'custom' ? t('Starting the agent…') : t('Starting the agent… The very first start downloads the adapter and can take a few minutes.');
		this.setBusy(true, this.client ? t('The agent is working…') : starting);
		this.stopped = false;
		const index = await this.target();
		if (!index) {
			this.refuse(text, t('There is no story folder to work in yet. Run "Novel Helper: Initialize Novel Workspace" first.'));
			return;
		}
		this.starting = new AbortController();
		let client: AgentClient;
		try {
			client = await this.connect(index, command, this.starting.signal);
		} catch (failure) {
			if (!this.starting.signal.aborted) {
				this.explain(failure, command, 'start');
			}
			this.post({ type: 'draft', text });
			return;
		} finally {
			this.starting = undefined;
		}

		try {
			await this.turn(index, command, client, text);
			await this.save();
		} catch (error) {
			this.explain(error, command, 'turn');
		}
	}

	private async turn(index: FolderIndex, command: AgentCommand, client: AgentClient, text: string): Promise<void> {
		const t = vscode.l10n.t;
		const store = this.storeOf(index.storyUri.fsPath);
		await saveUnsaved(index);
		const record = await store.begin({ kind: 'turn', title: titleOf(text) });
		const names = storyNames(index);
		const context = this.editorContext(index);
		const block = editorContextBlock({ ...context, notes: this.notes.splice(0) }, names.language);
		this.show(this.transcript.push({ kind: 'user', text, ...(this.contextText(context) && { context: this.contextText(context) }) }));
		this.setBusy(true, t('The agent is working…'));
		let stop = 'failed';
		let failure: unknown;
		try {
			if (this.stopped) {
				// Stopped before the message went out: there is nothing to cancel, and nothing is sent.
				stop = 'cancelled';
			} else {
				const blocks = [...(this.briefPending ? [workspaceBrief(names)] : []), ...(block ? [block] : []), text];
				this.briefPending = false;
				stop = await client.prompt(blocks);
			}
		} catch (error) {
			failure = error;
		}
		[...this.asks.values()].forEach((settle) => settle());
		const changes = await store.finish(record.id);
		this.transcript.endTurn({ kind: 'turn', ...(changes.length && { record: record.id }), stop, changes }).forEach((at) => this.show(at));
		if (changes.length) {
			this.filesChanged();
		}
		if (failure) {
			this.explain(failure, command, 'turn');
		}
		// VS Code loads a changed file again by itself unless it has unsaved edits; those it keeps, and asks on saving.
		const unsaved = changes.filter((change) => vscode.workspace.textDocuments.some((document) => document.isDirty && index.relative(document.uri) === change.path));
		if (unsaved.length) {
			this.notice(
				'info',
				t('{0}: changed by this turn while it had unsaved edits in the editor. The editor still shows your version; saving it asks which one to keep.', unsaved.map((change) => change.path).join(', ')),
			);
		}
	}

	/** Gives up starting the agent, or asks it to end the turn that is running. Open questions count as not allowed. */
	stop(): void {
		if (this.starting) {
			this.starting.abort();
			this.client?.stop();
			this.client = undefined;
		} else if (this.busy) {
			this.stopped = true;
			[...this.asks.values()].forEach((settle) => settle());
			void this.client?.cancel();
		}
	}

	/** Ends the conversation and clears the panel; a turn that is running is stopped first. The snapshots stay. */
	async newSession(): Promise<void> {
		this.stop();
		await this.running;
		await this.client?.close();
		this.session = undefined;
		this.notes = [];
		this.transcript = new Transcript();
		await this.save();
		this.showAll();
	}

	/** Opens VS Code's diff editor on a file as it was before and after a turn. */
	private async openDiff(id: number, file: string): Promise<void> {
		const index = await this.target();
		if (!index || leadsOut(file)) {
			return;
		}
		const store = this.storeOf(index.storyUri.fsPath);
		const change = (await store.get(id))?.changes?.find((one) => one.path === file);
		if (!change) {
			void vscode.window.showWarningMessage(vscode.l10n.t('That snapshot is no longer kept: only the last {0} are.', assistantSettings().keepSnapshots));
			return;
		}
		const kept = (hash = '') => vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${file}`, query: JSON.stringify({ story: store.story, hash }) });
		// While the file is still as the turn left it, the right side is the file itself and can be edited there.
		const untouched = change.after !== undefined && (await store.hashOf(file)) === change.after;
		const title = vscode.l10n.t('{0} (before ↔ after #{1})', file.slice(file.lastIndexOf('/') + 1), id);
		await vscode.commands.executeCommand('vscode.diff', kept(change.before), untouched ? index.uri(file) : kept(change.after), title);
	}

	/** Takes the story folder back to right before a snapshot, after asking; what it is now is kept first. */
	async revert(id: number): Promise<void> {
		await this.exclusive(() => this.goBack(id));
	}

	private async goBack(id: number): Promise<void> {
		const t = vscode.l10n.t;
		this.setBusy(true, t('Going back…'));
		const index = await this.target();
		if (!index) {
			return;
		}
		const store = this.storeOf(index.storyUri.fsPath);
		// Unsaved edits are saved first: they are part of what is kept before going back, and nothing is left for the editor to hold on to.
		await saveUnsaved(index);
		const plan = await store.preview(id);
		if (!plan) {
			void vscode.window.showWarningMessage(t('That snapshot is no longer kept: only the last {0} are.', assistantSettings().keepSnapshots));
			return;
		}
		if (plan.blocked.length) {
			await this.sayBlocked(id, plan.blocked);
			return;
		}
		if (plan.write.length + plan.remove.length === 0) {
			void vscode.window.showInformationMessage(t('Nothing to go back to: the files are as they were before that turn.'));
			return;
		}
		const go = t('Go Back');
		const detail = t(
			'{0} files are put back as they were, and {1} files made since are deleted. The story as it is now is kept as a snapshot first, so this can be undone the same way.',
			plan.write.length,
			plan.remove.length,
		);
		if ((await vscode.window.showWarningMessage(t('Go back to before #{0}?', id), { modal: true, detail }, go)) !== go) {
			return;
		}
		const { record, blocked } = await store.revert(id);
		if (blocked.length) {
			// Something got in the way while the question was open.
			await this.sayBlocked(id, blocked);
		} else if (record?.changes) {
			this.show(this.transcript.push({ kind: 'turn', record: record.id, stop: 'reverted', target: id, changes: record.changes }));
			this.notes.push(revertNote(record.changes.map((change) => change.path), storyNames(index).language));
			await this.save();
			this.filesChanged();
		}
	}

	/** Says why nothing was put back: which files are in the way, and what each is now. */
	private async sayBlocked(id: number, blocked: readonly Blocked[]): Promise<void> {
		const t = vscode.l10n.t;
		const why: Record<Blocked['why'], string> = {
			link: t('is a symbolic link now, or in a folder that is one'),
			large: t('is too large for a snapshot now (over 5 MB)'),
			binary: t('is not a text file now'),
			taken: t('has a folder in its place now, or a file in the place of its folder'),
		};
		const detail = [
			t('Going back would write over these files, and what they are now is nothing a snapshot keeps, so that could not be undone. Move or rename them, then go back again.'),
			'',
			...blocked.map((one) => `${one.path}: ${why[one.why]}`),
		].join('\n');
		await vscode.window.showWarningMessage(t('Did not go back to before #{0}: no file was changed.', id), { modal: true, detail });
	}

	/** "Go Back to Before a Turn…": the snapshots that are kept, newest first, also those of conversations that are no longer on the panel. */
	async history(): Promise<void> {
		const t = vscode.l10n.t;
		const index = await this.target();
		const records = index ? (await this.storeOf(index.storyUri.fsPath).list()).reverse() : [];
		if (!records.length) {
			void vscode.window.showInformationMessage(t('No snapshots yet. One is kept for every turn of the assistant that changes files.'));
			return;
		}
		const pick = await vscode.window.showQuickPick(
			records.map((record) => ({
				label: `#${record.id} ${record.kind === 'revert' ? t('Went back to before #{0}', record.target ?? '?') : (record.title ?? '')}`,
				description: new Date(record.time).toLocaleString(),
				detail: record.changes ? summary(record.changes) : t('The turn was not finished (the window was closed during it)'),
				id: record.id,
			})),
			{ title: t('Go back to before a turn'), placeHolder: t('The files are put back as they were right before the turn you pick.') },
		);
		if (pick) {
			await this.revert(pick.id);
		}
	}

	dispose(): void {
		clearTimeout(this.contextTimer);
		// An agent that is still being started is not `client` yet.
		this.starting?.abort();
		this.client?.stop();
		this.disposables.forEach((disposable) => disposable.dispose());
	}
}
