// A stand-in for the `vscode` module, backed by a real temporary folder, so
// that the extension as a whole (index, sidebar commands, ghost text) can be
// driven from node:test: `start()` makes a workspace, loads a fresh copy of
// the extension against the stand-in, and activates it. Only what the
// extension uses is here, and only as much of its behaviour as the tests
// rely on.

import * as fs from 'node:fs';
import Module = require('node:module');
import * as os from 'node:os';
import * as path from 'node:path';

type Any = any;
type Listener = (value?: Any) => void;

class Uri {
	readonly fsPath: string;
	constructor(
		readonly scheme: string,
		readonly path: string,
		readonly query = '',
	) {
		this.fsPath = path;
	}
	static file(p: string): Uri {
		return new Uri('file', p);
	}
	static from({ scheme, path: p, query }: { scheme: string; path: string; query?: string }): Uri {
		return new Uri(scheme, p, query);
	}
	static parse(text: string): Uri {
		const [, scheme, rest] = /^([a-z][\w+.-]*):(?:\/\/)?(.*)$/i.exec(text)!;
		return new Uri(scheme, rest);
	}
	static joinPath(base: Uri, ...parts: string[]): Uri {
		return new Uri(base.scheme, path.posix.join(base.path, ...parts));
	}
	toString(): string {
		return `${this.scheme}://${this.path}${this.query && `?${this.query}`}`;
	}
}

class EventEmitter {
	private readonly listeners = new Set<Listener>();
	readonly event = (listener: Listener) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	fire(value?: Any): void {
		[...this.listeners].forEach((listener) => listener(value));
	}
	dispose(): void {}
}

class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
}

class Range {
	constructor(
		readonly start: Position,
		readonly end: Position,
	) {}
}

class Selection extends Range {
	get active(): Position {
		return this.end;
	}
	get isEmpty(): boolean {
		return this.start.line === this.end.line && this.start.character === this.end.character;
	}
}

class ThemeIcon {
	static readonly File = new ThemeIcon('file');
	static readonly Folder = new ThemeIcon('folder');
	constructor(readonly id: string) {}
}

class TreeItem {
	[key: string]: Any;
	constructor(
		public label: string,
		public collapsibleState = 0,
	) {}
}

class WorkspaceEdit {
	readonly ops: Any[] = [];
	createFile(uri: Uri, options: Any = {}): void {
		this.ops.push({ type: 'create', uri, options });
	}
	renameFile(from: Uri, to: Uri): void {
		this.ops.push({ type: 'rename', from, to });
	}
	replace(uri: Uri, range: Range, text: string): void {
		this.ops.push({ type: 'replace', uri, range, text });
	}
}

/** `**`, `*`, `{a,b}`: the globs the extension and its default settings use. */
function globToRegex(glob: string): RegExp {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (glob.startsWith('**/', i)) {
			out += '(?:.*/)?';
			i += 2;
		} else if (glob.startsWith('**', i)) {
			out += '.*';
			i += 1;
		} else if (c === '*') {
			out += '[^/]*';
		} else if (c === '{') {
			out += '(?:';
		} else if (c === '}') {
			out += ')';
		} else if (c === ',') {
			out += '|';
		} else {
			out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`);
}

/** Files below `dir`, relative and `/`-separated, in name order. */
export function filesIn(dir: string, relative = ''): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name), `${relative}${entry.name}/`) : [`${relative}${entry.name}`]));
}

export interface Asked {
	kind: 'pick' | 'input' | 'dialog';
	title?: string;
	value?: string;
	items?: string[];
	/** What the input box's validation said about the scripted answer. */
	problem?: string;
}

export interface Panel {
	html: string;
	options: Any;
	/** Every message the extension posted to the page. */
	posted: Any[];
	/** A message from the page to the extension. */
	send(message: Any): void;
}

export interface Started {
	/** The workspace folder; `base` is its parent, for files that are to be outside the workspace. */
	workspace: string;
	base: string;
	storage: string;
	vscode: Any;
	context: Any;
	commands: Record<string, (...args: Any[]) => Any>;
	providers: Any;
	trees: Record<string, Any>;
	/** The tree views made with `createTreeView`, for what is set on them (`message`). */
	views: Record<string, Any>;
	/** The status bar item. */
	statusItem: Any;
	settings: Record<string, unknown>;
	/** Every `update` of a setting, as `[key, value]`. */
	updates: Array<[string, unknown]>;
	/** Scripted answers for the quick picks, input boxes and folder dialogs to come, in order. */
	answers: Array<(arg: Any) => Any>;
	asked: Asked[];
	/** What was shown with showInformationMessage, showWarningMessage and showErrorMessage. */
	messages: string[];
	/** The `detail` of those that had one. */
	details: string[];
	/** The webview views that were registered, by id. */
	webviews: Record<string, Any>;
	/** What was opened in the diff editor: `[left, right, title]`. */
	diffs: Array<[Uri, Uri, string]>;
	/** Addresses handed to `env.openExternal`. */
	external: string[];
	/** Opens a webview view as VS Code does when it is first shown, and returns its page's side: what it was sent, and a way to send to the extension. */
	panel(id: string): Panel;
	/** Selects text in the active editor: lines and characters from 0. */
	select(startLine: number, startCharacter: number, endLine: number, endCharacter: number): void;
	/** Types into an open document without saving it. */
	type(relative: string, content: string): void;
	/** Closes the window and opens it again: the extension is activated anew, with what it kept in the workspace's state. */
	reopen(): Promise<void>;
	/** Paths the extension read through `workspace.fs`. */
	reads: string[];
	/** File system watchers created and not disposed. */
	watchers(): number;
	/** Makes `workspace.fs.stat` wait until the returned function is called. */
	holdStat(): () => void;
	/** Tells the watchers about a file made, changed or removed behind VS Code's back. */
	changedOutside(type: 'create' | 'change' | 'delete', relative: string): void;
	read(relative: string): string;
	write(relative: string, content?: string): void;
	files(): string[];
	/** The node of a view at a path of labels. */
	find(view: string, ...labels: string[]): Promise<Any>;
	/** The labels of a view's nodes, indented by depth. */
	labels(view: string): Promise<string[]>;
	settle(): Promise<void>;
	dispose(): void;
}

const root = path.resolve(__dirname, '../..');
const defaults = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.configuration.properties as Record<string, { default: unknown }>;
let current: Any;
const load = (Module as Any)._load;
(Module as Any)._load = function (this: unknown, request: string, ...rest: unknown[]) {
	return request === 'vscode' ? current : load.call(this, request, ...rest);
};

/**
 * A workspace folder made by `prepare`, and the extension activated in it.
 * `prepare` gets the folder and its parent. Call `dispose()` when done: it
 * deactivates the extension and removes everything.
 */
export async function start(prepare: (workspace: string, base: string) => void, settings: Record<string, unknown> = {}): Promise<Started> {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-test-'));
	const workspace = path.join(base, 'workspace');
	const storage = path.join(base, 'storage');
	fs.mkdirSync(workspace);
	prepare(workspace, base);

	const folder = { uri: Uri.file(workspace), name: 'workspace', index: 0 };
	const commands: Started['commands'] = {};
	const providers: Any = {};
	const trees: Started['trees'] = {};
	const views: Started['views'] = {};
	const statusItem: Any = { show() {}, hide() {}, dispose() {} };
	const updates: Started['updates'] = [];
	const answers: Started['answers'] = [];
	const asked: Asked[] = [];
	const messages: string[] = [];
	const details: string[] = [];
	const webviews: Started['webviews'] = {};
	const diffs: Started['diffs'] = [];
	const external: string[] = [];
	const selectionChanged = new EventEmitter();
	const workspaceState = new Map<string, unknown>();
	const reads: string[] = [];
	const documents = new Map<string, Any>();
	const liveWatchers = new Set<Any>();
	const configChanged = new EventEmitter();
	const editorChanged = new EventEmitter();
	const renamed = new EventEmitter();
	const created = new EventEmitter();
	const secretChanged = new EventEmitter();
	const secrets = new Map<string, string>();
	let statGate: Promise<void> | undefined;
	const baseOf = (pattern: Any): string => (typeof pattern === 'string' ? workspace : (pattern.base.uri ?? pattern.base).path);
	const globOf = (pattern: Any): string => (typeof pattern === 'string' ? pattern : pattern.pattern);
	const emit = (type: 'create' | 'change' | 'delete', file: string) => {
		for (const watcher of liveWatchers) {
			if (file.startsWith(`${watcher.base}/`) && watcher.regex.test(file.slice(watcher.base.length + 1))) {
				watcher[type].fire(Uri.file(file));
			}
		}
	};
	const offsetAt = (content: string, position: Position) =>
		content.split('\n').slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
	const positionAt = (content: string, offset: number) => {
		const before = content.slice(0, offset).split('\n');
		return new Position(before.length - 1, before[before.length - 1].length);
	};
	const documentFor = (uri: Uri) => {
		let document = documents.get(uri.path);
		if (!document) {
			document = {
				uri,
				isUntitled: false,
				languageId: 'markdown',
				content: fs.readFileSync(uri.path, 'utf8'),
				get isDirty() {
					return !fs.existsSync(this.uri.path) || fs.readFileSync(this.uri.path, 'utf8') !== this.content;
				},
				getText(range?: Range) {
					return range ? this.content.slice(offsetAt(this.content, range.start), offsetAt(this.content, range.end)) : this.content;
				},
				positionAt(offset: number) {
					return positionAt(this.content, offset);
				},
				offsetAt(position: Position) {
					return offsetAt(this.content, position);
				},
				lineAt(line: number) {
					return { text: this.content.split('\n')[line] };
				},
				async save() {
					fs.writeFileSync(this.uri.path, this.content);
					emit('change', this.uri.path);
					return true;
				},
			};
			documents.set(uri.path, document);
		}
		return document;
	};
	// A modal message waits for one of its buttons: the next scripted answer picks it. Any other message is only noted.
	const message = async (text: string, ...rest: Any[]) => {
		messages.push(text);
		if (rest[0]?.detail !== undefined) {
			details.push(rest[0].detail);
		}
		return rest[0]?.modal ? answers.shift()!(rest.slice(1)) : undefined;
	};

	const vscode: Any = {
		Uri,
		EventEmitter,
		Position,
		Range,
		Selection,
		ThemeIcon,
		TreeItem,
		WorkspaceEdit,
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		FileType: { File: 1, Directory: 2 },
		RelativePattern: class {
			constructor(
				readonly base: Any,
				readonly pattern: string,
			) {}
		},
		InlineCompletionItem: class {
			constructor(
				readonly insertText: string,
				readonly range: Range,
			) {}
		},
		InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
		StatusBarAlignment: { Right: 2 },
		ProgressLocation: { Window: 10 },
		ViewColumn: { Beside: -2 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		Hover: class {},
		MarkdownString: class {},
		env: {
			language: 'en',
			openExternal: async (uri: Uri) => {
				external.push(uri.toString());
				return true;
			},
		},
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
		workspace: {
			workspaceFolders: [folder],
			isTrusted: true,
			get textDocuments() {
				return [...documents.values()];
			},
			getWorkspaceFolder: (uri: Uri) => (uri.path.startsWith(`${workspace}/`) ? folder : undefined),
			getConfiguration: (section: string) => ({
				get: (key: string, fallback: unknown) => {
					const full = `${section}.${key}`;
					return full in settings ? settings[full] : full in defaults ? defaults[full].default : fallback;
				},
				inspect: () => ({}),
				update: async (key: string, value: unknown) => {
					const full = `${section}.${key}`;
					updates.push([full, value]);
					if (value === undefined) {
						delete settings[full];
					} else {
						settings[full] = value;
					}
					configChanged.fire({ affectsConfiguration: (s: string) => full === s || full.startsWith(`${s}.`) });
				},
			}),
			// Like VS Code: what the exclude glob matches is left out first, then the result is cut at `maxResults`.
			findFiles: async (pattern: Any, exclude?: string, maxResults?: number) => {
				const include = globToRegex(globOf(pattern));
				const not = exclude ? globToRegex(exclude) : undefined;
				return filesIn(baseOf(pattern))
					.filter((file) => include.test(file) && !not?.test(file))
					.slice(0, maxResults)
					.map((file) => Uri.file(path.join(baseOf(pattern), file)));
			},
			createFileSystemWatcher: (pattern: Any) => {
				const watcher = { base: baseOf(pattern), regex: globToRegex(globOf(pattern)), create: new EventEmitter(), change: new EventEmitter(), delete: new EventEmitter() };
				liveWatchers.add(watcher);
				return {
					onDidCreate: watcher.create.event,
					onDidChange: watcher.change.event,
					onDidDelete: watcher.delete.event,
					dispose: () => liveWatchers.delete(watcher),
				};
			},
			fs: {
				readFile: async (uri: Uri) => {
					reads.push(uri.path);
					return fs.promises.readFile(uri.path);
				},
				writeFile: async (uri: Uri, data: Uint8Array) => {
					await fs.promises.writeFile(uri.path, data);
					emit('create', uri.path);
				},
				createDirectory: async (uri: Uri) => {
					await fs.promises.mkdir(uri.path, { recursive: true });
				},
				rename: async (from: Uri, to: Uri) => {
					await fs.promises.rename(from.path, to.path);
				},
				stat: async (uri: Uri) => {
					await statGate;
					return { type: (await fs.promises.stat(uri.path)).isDirectory() ? 2 : 1 };
				},
			},
			// `providers.content` is the extension's own scheme; the others are kept by their scheme.
			registerTextDocumentContentProvider: (scheme: string, provider: Any) => {
				providers[scheme === 'novel-helper' ? 'content' : scheme] = provider;
				return { dispose() {} };
			},
			openTextDocument: async (uri: Uri) =>
				uri.scheme === 'file'
					? documentFor(uri)
					: { uri, languageId: 'markdown', getText: () => providers[uri.scheme === 'novel-helper' ? 'content' : uri.scheme].provideTextDocumentContent(uri) },
			// Like VS Code: checked as a whole first, then done step by step; a step that fails leaves the earlier ones done.
			applyEdit: async (edit: WorkspaceEdit) => {
				for (const op of edit.ops) {
					if (op.type === 'rename' && fs.existsSync(op.to.path)) {
						return false;
					}
				}
				const moved: Any[] = [];
				const made: Uri[] = [];
				for (const op of edit.ops) {
					if (op.type === 'create') {
						if (fs.existsSync(op.uri.path)) {
							continue;
						}
						fs.mkdirSync(path.dirname(op.uri.path), { recursive: true });
						fs.writeFileSync(op.uri.path, op.options.contents ?? '');
						emit('create', op.uri.path);
						made.push(op.uri);
					} else if (op.type === 'rename') {
						const inside = fs.statSync(op.from.path).isDirectory() ? filesIn(op.from.path) : [''];
						fs.renameSync(op.from.path, op.to.path);
						for (const file of inside) {
							emit('delete', path.join(op.from.path, file));
							emit('create', path.join(op.to.path, file));
						}
						moved.push({ oldUri: op.from, newUri: op.to });
					} else {
						const document = documentFor(op.uri);
						const from = document.offsetAt(op.range.start);
						document.content = document.content.slice(0, from) + op.text + document.content.slice(document.offsetAt(op.range.end));
					}
				}
				if (made.length) {
					created.fire({ files: made });
				}
				if (moved.length) {
					renamed.fire({ files: moved });
				}
				return true;
			},
			onDidChangeConfiguration: configChanged.event,
			onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
			onDidRenameFiles: renamed.event,
			onDidCreateFiles: created.event,
			onDidDeleteFiles: () => ({ dispose() {} }),
		},
		window: {
			activeTextEditor: undefined,
			createOutputChannel: () => ({ info() {}, warn() {}, dispose() {} }),
			createStatusBarItem: () => statusItem,
			onDidChangeActiveTextEditor: editorChanged.event,
			onDidChangeTextEditorSelection: selectionChanged.event,
			showTextDocument: async (target: Any) => {
				const document = target instanceof Uri ? await vscode.workspace.openTextDocument(target) : target;
				vscode.window.activeTextEditor = { document, selection: new Selection(new Position(0, 0), new Position(0, 0)) };
				editorChanged.fire(vscode.window.activeTextEditor);
			},
			withProgress: async (_: unknown, task: () => Promise<unknown>) => task(),
			registerWebviewViewProvider: (id: string, provider: Any) => {
				webviews[id] = provider;
				return { dispose: () => delete webviews[id] };
			},
			showWarningMessage: message,
			showInformationMessage: message,
			showErrorMessage: message,
			showWorkspaceFolderPick: async () => folder,
			showOpenDialog: async () => {
				asked.push({ kind: 'dialog' });
				return answers.shift()!(undefined);
			},
			showQuickPick: async (items: Any[], options: Any) => {
				asked.push({ kind: 'pick', title: options.title, items: items.map((item) => item.label) });
				return answers.shift()!(items);
			},
			// Like VS Code: a value the validation rejects is not accepted; here that ends the input.
			showInputBox: async (options: Any) => {
				const value = answers.shift()!(options);
				const problem = value !== undefined ? options.validateInput?.(value) : undefined;
				asked.push({ kind: 'input', title: options.title, value: options.value, problem: problem ?? undefined });
				return problem ? undefined : value;
			},
			registerTreeDataProvider: (id: string, provider: Any) => {
				trees[id] = provider;
				return { dispose() {} };
			},
			createTreeView: (id: string, options: Any) => {
				trees[id] = options.treeDataProvider;
				views[id] = { visible: true, message: undefined, onDidChangeVisibility: () => ({ dispose() {} }), reveal: async () => {}, dispose() {} };
				return views[id];
			},
		},
		languages: {
			registerInlineCompletionItemProvider: (_: unknown, provider: Any) => {
				providers.inline = provider;
				return { dispose() {} };
			},
			registerHoverProvider: () => ({ dispose() {} }),
			registerDefinitionProvider: () => ({ dispose() {} }),
		},
		commands: {
			registerCommand: (id: string, run: (...args: Any[]) => Any) => {
				commands[id] = run;
				return { dispose() {} };
			},
			executeCommand: async (id: string, ...args: Any[]) => {
				if (id === 'vscode.diff') {
					diffs.push(args as [Uri, Uri, string]);
					return undefined;
				}
				return id === 'vscode.open' ? vscode.window.showTextDocument(args[0]) : commands[id]?.(...args);
			},
		},
	};
	const context: Any = {
		subscriptions: [],
		secrets: {
			get: async (key: string) => secrets.get(key),
			store: async (key: string, value: string) => {
				secrets.set(key, value);
				secretChanged.fire({ key });
			},
			delete: async (key: string) => {
				secrets.delete(key);
				secretChanged.fire({ key });
			},
			onDidChange: secretChanged.event,
		},
		globalStorageUri: Uri.file(storage),
		extensionUri: Uri.file(root),
		workspaceState: {
			get: (key: string) => workspaceState.get(key),
			// Like VS Code: what is kept is a copy, as JSON would make it.
			update: async (key: string, value: unknown) => void workspaceState.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
		},
	};

	// A fresh copy of the extension for every start: its modules keep state, and hold on to the `vscode` they were loaded with.
	const activate = () => {
		current = vscode;
		for (const key of Object.keys(require.cache)) {
			if (key.startsWith(path.join(root, 'out') + path.sep) && !key.includes(`${path.sep}test${path.sep}`)) {
				delete require.cache[key];
			}
		}
		(require('../extension') as { activate(context: Any): void }).activate(context);
	};
	activate();

	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 250));
	const find = async (view: string, ...labels: string[]) => {
		let element: Any;
		for (const label of labels) {
			const children: Any[] = await trees[view].getChildren(element);
			const items = await Promise.all(children.map((child) => trees[view].getTreeItem(child)));
			element = children[items.findIndex((item) => item.label === label)];
			if (!element) {
				throw new Error(`no ${label} in ${view}: ${items.map((item) => item.label).join(', ')}`);
			}
		}
		return element;
	};
	const labels = async (view: string, element?: Any, depth = 0): Promise<string[]> => {
		const out: string[] = [];
		for (const child of await trees[view].getChildren(element)) {
			out.push('  '.repeat(depth) + (await trees[view].getTreeItem(child)).label, ...(await labels(view, child, depth + 1)));
		}
		return out;
	};
	await settle();
	return {
		workspace,
		base,
		storage,
		vscode,
		context,
		commands,
		providers,
		trees,
		views,
		statusItem,
		settings,
		updates,
		answers,
		asked,
		messages,
		details,
		webviews,
		diffs,
		external,
		panel: (id) => {
			const received = new EventEmitter();
			const panel: Panel = { html: '', options: undefined, posted: [], send: (sent) => received.fire(sent) };
			webviews[id].resolveWebviewView({
				webview: {
					cspSource: 'vscode-resource:',
					asWebviewUri: (uri: Uri) => `vscode-resource:${uri.path}`,
					postMessage: async (posted: Any) => void panel.posted.push(JSON.parse(JSON.stringify(posted))),
					onDidReceiveMessage: received.event,
					set html(html: string) {
						panel.html = html;
					},
					set options(options: Any) {
						panel.options = options;
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			});
			return panel;
		},
		select: (startLine, startCharacter, endLine, endCharacter) => {
			vscode.window.activeTextEditor.selection = new Selection(new Position(startLine, startCharacter), new Position(endLine, endCharacter));
			selectionChanged.fire({ textEditor: vscode.window.activeTextEditor });
		},
		type: (relative, content) => {
			documentFor(Uri.file(path.join(workspace, relative))).content = content;
		},
		reopen: async () => {
			context.subscriptions.splice(0).forEach((subscription: Any) => subscription.dispose());
			documents.clear();
			vscode.window.activeTextEditor = undefined;
			activate();
			await settle();
		},
		reads,
		watchers: () => liveWatchers.size,
		holdStat: () => {
			let release!: () => void;
			statGate = new Promise((resolve) => (release = resolve));
			return () => {
				statGate = undefined;
				release();
			};
		},
		changedOutside: (type, relative) => emit(type, path.join(workspace, relative)),
		read: (relative) => fs.readFileSync(path.join(workspace, relative), 'utf8'),
		write: (relative, content = '') => {
			fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
			fs.writeFileSync(path.join(workspace, relative), content);
		},
		files: () => filesIn(workspace),
		find,
		labels: (view) => labels(view),
		settle,
		dispose: () => {
			context.subscriptions.forEach((subscription: Any) => subscription.dispose());
			fs.rmSync(base, { recursive: true, force: true });
		},
	};
}
