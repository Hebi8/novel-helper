// Keeps one Library per workspace folder in sync with the files on disk:
// a full scan when the folder is first needed, then file watchers.

import * as vscode from 'vscode';
import { type FileKind, globFolders, globRootDepth, Library } from '../core/library';
import { filePatterns } from './config';

/** Text of a file: the editor's copy if it is open (possibly unsaved), else the file on disk. */
export async function readText(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (open) {
		return open.getText();
	}
	return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

type Kind = 'lore' | FileKind;

export class FolderIndex implements vscode.Disposable {
	readonly library: Library;
	readonly ready: Promise<void>;
	private readonly disposables: vscode.Disposable[] = [];
	/** Counts events per lore file, so a slow read cannot undo a later change or deletion. */
	private readonly loreEvents = new Map<string, number>();

	/** After the first scan, every change to the library is announced. */
	private loaded = false;

	constructor(
		readonly folder: vscode.WorkspaceFolder,
		private readonly log: vscode.LogOutputChannel,
		private readonly onChange: () => void,
	) {
		this.library = new Library(filePatterns(folder.uri).bookNames);
		this.ready = this.load();
	}

	/** The folders the settings root a kind of file in, in the order written: 正文, 章节… */
	folders(kind: Kind): string[] {
		const patterns = filePatterns(this.folder.uri);
		const globs = { lore: patterns.lore, chapter: patterns.chapters, outline: patterns.outlines, summary: patterns.summaries };
		return globs[kind].flatMap(globFolders);
	}

	/** The folder new files of a kind go under: the one in use the most, else the first of the settings. */
	root(kind: FileKind): string {
		return this.library.roots(kind)[0] ?? this.folders(kind)[0] ?? '';
	}

	/** `/`-separated path relative to the folder root. */
	relative(uri: vscode.Uri): string {
		return uri.path.slice(this.folder.uri.path.replace(/\/$/, '').length + 1);
	}

	uri(relative: string): vscode.Uri {
		return vscode.Uri.joinPath(this.folder.uri, ...relative.split('/'));
	}

	private async load(): Promise<void> {
		const patterns = filePatterns(this.folder.uri);
		const groups: Array<[Kind, string[]]> = [
			['lore', patterns.lore],
			['chapter', patterns.chapters],
			['outline', patterns.outlines],
			['summary', patterns.summaries],
		];
		await Promise.all(
			groups.flatMap(([kind, globs]) =>
				globs.map(async (glob) => {
					const pattern = new vscode.RelativePattern(this.folder, glob);
					const rootDepth = globRootDepth(glob);
					const watcher = vscode.workspace.createFileSystemWatcher(pattern);
					this.disposables.push(
						watcher,
						watcher.onDidCreate((uri) => this.add(kind, uri, rootDepth)),
						watcher.onDidDelete((uri) => this.remove(kind, uri)),
					);
					if (kind === 'lore') {
						this.disposables.push(watcher.onDidChange((uri) => this.add(kind, uri, rootDepth)));
					}
					const uris = await vscode.workspace.findFiles(pattern);
					await Promise.all(uris.map((uri) => this.add(kind, uri, rootDepth)));
				}),
			),
		);
		this.loaded = true;
		this.log.info(
			`Indexed ${this.folder.name}: ${this.library.entries().length} lore entries, ${this.library.chapterList().length} chapters`,
		);
	}

	private changed(): void {
		if (this.loaded) {
			this.onChange();
		}
	}

	private async add(kind: Kind, uri: vscode.Uri, rootDepth: number): Promise<void> {
		const path = this.relative(uri);
		if (kind !== 'lore') {
			this.library.addFile(kind, path, rootDepth);
			this.changed();
			return;
		}
		const event = this.loreEvent(path);
		try {
			const content = await readText(uri);
			if (this.loreEvents.get(path) !== event) {
				return;
			}
			const entry = this.library.setLore(path, content);
			if (entry.error) {
				this.log.warn(`${path}: frontmatter ignored: ${entry.error}`);
			}
			this.changed();
		} catch (error) {
			this.log.warn(`${path}: could not read: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private remove(kind: Kind, uri: vscode.Uri): void {
		const path = this.relative(uri);
		if (kind === 'lore') {
			this.loreEvent(path);
			this.library.deleteLore(path);
		} else {
			this.library.deleteFile(kind, path);
		}
		this.changed();
	}

	private loreEvent(path: string): number {
		const event = (this.loreEvents.get(path) ?? 0) + 1;
		this.loreEvents.set(path, event);
		return event;
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}

export interface Located {
	index: FolderIndex;
	/** Path relative to the folder; for unsaved documents, their name. */
	path: string;
}

export class WorkspaceIndexes implements vscode.Disposable {
	private readonly folders = new Map<string, FolderIndex>();
	private readonly changed = new vscode.EventEmitter<void>();
	private timer?: ReturnType<typeof setTimeout>;

	/** Fires a moment after files of a novel are added, removed or renamed, or a lore entry is edited. */
	readonly onDidChange = this.changed.event;

	constructor(private readonly log: vscode.LogOutputChannel) {}

	/** Many files can change at once (a folder renamed): one event for all of them. */
	private notify(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.changed.fire(), 100);
	}

	/** The index of every open folder. */
	all(): Promise<FolderIndex[]> {
		return Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => this.get(folder)));
	}

	async get(folder: vscode.WorkspaceFolder): Promise<FolderIndex> {
		const key = folder.uri.toString();
		let index = this.folders.get(key);
		if (!index) {
			index = new FolderIndex(folder, this.log, () => this.notify());
			this.folders.set(key, index);
		}
		await index.ready;
		return index;
	}

	/** The folder index a document belongs to; an unsaved document uses the only open folder. */
	async locate(document: vscode.TextDocument): Promise<Located | undefined> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const folder =
			vscode.workspace.getWorkspaceFolder(document.uri) ??
			(document.isUntitled && folders.length === 1 ? folders[0] : undefined);
		if (!folder) {
			return undefined;
		}
		const index = await this.get(folder);
		return { index, path: document.isUntitled ? document.uri.path : index.relative(document.uri) };
	}

	/** Drops indexes so they are rebuilt on next use (after settings change or folders are removed). */
	reset(keep: readonly vscode.WorkspaceFolder[] = []): void {
		const kept = new Set(keep.map((f) => f.uri.toString()));
		for (const [key, index] of this.folders) {
			if (!kept.has(key)) {
				index.dispose();
				this.folders.delete(key);
			}
		}
		this.notify();
	}

	dispose(): void {
		this.reset();
		clearTimeout(this.timer);
		this.changed.dispose();
	}
}
