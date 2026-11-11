// The sidebar's tree of the book: the book, its volumes and arcs, its
// chapters. It lays out what is there and makes the files; what goes in them
// is written in the editor.

import * as vscode from 'vscode';
import { nameProblem, suggestChapterName, suggestLevelName } from '../core/book';
import type { BookNode } from '../core/library';
import { firstNames } from '../core/scaffold';
import { isUsable } from '../core/story';
import { setStoryFolder } from './config';
import { createAndOpen, joinPath, pickIndex, problemText } from './files';
import { displayNamesLanguage, storyLabel } from './story';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

export interface BookItem {
	index: FolderIndex;
	node: BookNode;
	/** Undefined for the book itself. */
	parent?: BookItem;
}

/**
 * Shown in place of a book while the story folder cannot be used: another
 * story folder found in the workspace folder, to switch to; or, without
 * `story`, the way to initialize the current one.
 */
interface StoryItem {
	index: FolderIndex;
	story?: string;
}

type Item = BookItem | StoryItem;

function isBook(item: Item): item is BookItem {
	return 'node' in item;
}

/** The names a story's first volume and first chapter get: in the language it was set up in, else the display language. */
function firstNamesOf(index: FolderIndex): { volume: string; chapter: string } {
	return firstNames(index.marker?.language ?? displayNamesLanguage());
}

function childrenOf(item: BookItem): BookItem[] {
	return item.node.children.map((node) => ({ index: item.index, node, parent: item }));
}

function bookOf(item: BookItem): BookItem {
	return item.parent ? bookOf(item.parent) : item;
}

function findChapter(item: BookItem, path: string): BookItem | undefined {
	if (item.node.kind === 'chapter') {
		return item.node.path === path ? item : undefined;
	}
	for (const child of childrenOf(item)) {
		const found = findChapter(child, path);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/** The book or level the last chapter is in: where the writing goes on. */
function lastLevel(item: BookItem): BookItem {
	const last = childrenOf(item).at(-1);
	return last && last.node.kind !== 'chapter' ? lastLevel(last) : item;
}

function count(node: BookNode): number {
	return node.kind === 'chapter' ? 1 : node.children.reduce((n, child) => n + count(child), 0);
}

export class BookView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly view: vscode.TreeView<Item>;
	private readonly disposables: vscode.Disposable[];
	/** The chapter the tree last moved its selection to. */
	private revealed?: string;

	constructor(private readonly indexes: WorkspaceIndexes) {
		this.view = vscode.window.createTreeView('novelHelper.book', { treeDataProvider: this, showCollapseAll: true });
		const command = (id: string, run: (item?: BookItem) => Promise<void>) => vscode.commands.registerCommand(id, run);
		this.disposables = [
			this.changed,
			this.view,
			indexes.onDidChange(() => {
				this.changed.fire();
				void this.describe();
				// A chapter just made is opened before the index has it.
				void this.revealActive();
			}),
			vscode.commands.registerCommand('novelHelper.book.useStory', (item: StoryItem) => setStoryFolder(item.index.folder, item.story ?? '')),
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.revealed = undefined;
				return this.revealActive();
			}),
			this.view.onDidChangeVisibility(() => this.revealActive()),
			command('novelHelper.book.openOutline', (item) => this.openCompanion(item, 'outline')),
			command('novelHelper.book.openSummary', (item) => this.openCompanion(item, 'summary')),
			command('novelHelper.book.newChapter', (item) => this.newChapter(item)),
			command('novelHelper.book.newLevel', (item) => this.newLevel(item)),
			command('novelHelper.book.rename', (item) => this.rename(item)),
		];
		void this.describe();
	}

	/** One book per open folder whose story folder can be used. */
	private async books(): Promise<BookItem[]> {
		const indexes = await this.indexes.all();
		return indexes.filter((index) => isUsable(index.state)).map((index) => ({ index, node: index.library.tree() }));
	}

	/**
	 * A folder's book; or, while its story folder cannot be used, the story
	 * folders found in it and the way to initialize; or nothing, which
	 * leaves the view to its welcome text.
	 */
	async getChildren(item?: Item): Promise<Item[]> {
		if (item) {
			return isBook(item) ? childrenOf(item) : [];
		}
		const indexes = await this.indexes.all();
		return indexes.flatMap((index): Item[] => {
			if (isUsable(index.state)) {
				return [{ index, node: index.library.tree() }];
			}
			return index.others.length ? [...index.others.map((story) => ({ index, story })), { index }] : [];
		});
	}

	getParent(item: Item): Item | undefined {
		return isBook(item) ? item.parent : undefined;
	}

	/** Above the tree: which story folder cannot be used and why. Nothing while all is well. */
	private async describe(): Promise<void> {
		const t = vscode.l10n.t;
		const lines = (await this.indexes.all()).flatMap((index) => {
			const state = index.state;
			const found = (why: string) =>
				index.others.length ? t('{0} Story folders found in this workspace are listed below: click one to use it.', why) : why;
			if (state === 'invalid') {
				return [found(t('The story folder setting "{0}" is not a path inside the workspace folder.', index.storySetting))];
			}
			if (state === 'missing') {
				return [found(t('The story folder {0} does not exist.', index.story!))];
			}
			// The workspace folder itself with nothing in it is what the welcome text is about.
			return state === 'empty' && (index.story || index.others.length)
				? [found(t('The story folder {0} has nothing of a novel in it yet.', storyLabel(index.story!)))]
				: [];
		});
		this.view.message = lines.join(' ') || undefined;
	}

	getTreeItem(element: Item): vscode.TreeItem {
		const t = vscode.l10n.t;
		if (!isBook(element)) {
			const folder = element.index.folder.uri.toString();
			if (element.story === undefined) {
				const item = new vscode.TreeItem(t('Initialize a story folder…'));
				item.id = `${folder}#init`;
				item.iconPath = new vscode.ThemeIcon('add');
				item.command = { command: 'novelHelper.init', title: t('Initialize a story folder…') };
				return item;
			}
			const item = new vscode.TreeItem(storyLabel(element.story));
			item.id = `${folder}#story:${element.story}`;
			item.iconPath = new vscode.ThemeIcon('book');
			item.description = t('initialized story folder: click to use it');
			item.contextValue = 'story';
			item.command = { command: 'novelHelper.book.useStory', title: t('Use as Story Folder'), arguments: [element] };
			return item;
		}
		const { index, node } = element;
		const state =
			node.kind === 'chapter'
				? vscode.TreeItemCollapsibleState.None
				: node.kind === 'book'
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(node.name, state);
		// The same node keeps its id from one refresh to the next, so what was expanded stays expanded.
		item.id = `${index.folder.uri.toString()}#${node.kind}:${node.path}`;
		item.contextValue = node.kind;
		const outline = node.outline ? t('outline ✓') : t('outline ✗');
		const lines = [node.outline ? t('Outline: {0}', node.outline) : t('Outline: none yet')];
		if (node.kind === 'chapter') {
			const uri = index.uri(node.path);
			item.resourceUri = uri;
			item.command = { command: 'vscode.open', title: t('Open'), arguments: [uri] };
			item.description = `${outline} · ${node.summary ? t('summary ✓') : t('summary ✗')}`;
			lines.unshift(node.path);
			lines.push(node.summary ? t('Summary: {0}', node.summary) : t('Summary: none yet'));
		} else if (node.kind === 'level') {
			item.resourceUri = index.uri(node.path);
			item.iconPath = vscode.ThemeIcon.Folder;
			item.description = `${t('{0} chapters', count(node))} · ${outline}`;
			lines.unshift(node.path);
		} else {
			item.iconPath = new vscode.ThemeIcon('book');
			const folders = vscode.workspace.workspaceFolders ?? [];
			const place = [folders.length > 1 ? index.folder.name : '', index.story].filter(Boolean).join('/');
			item.description = [place, t('{0} chapters', count(node)), outline].filter(Boolean).join(' · ');
		}
		item.tooltip = lines.join('\n');
		return item;
	}

	/**
	 * Selects the chapter being edited, opening the levels it is in; once per
	 * chapter, so that the selection is the writer's again after that.
	 */
	private async revealActive(): Promise<void> {
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (!uri || !this.view.visible || this.revealed === uri.toString()) {
			return;
		}
		for (const book of await this.books()) {
			const path = book.index.relative(uri);
			if (path !== undefined && vscode.workspace.getWorkspaceFolder(uri) === book.index.folder) {
				const chapter = findChapter(book, path);
				if (chapter) {
					this.revealed = uri.toString();
					await this.view.reveal(chapter, { select: true, focus: false, expand: true });
				}
			}
		}
	}

	/** The book of the folder the writer is in, for commands run from the view's title or the command palette. */
	private async book(): Promise<BookItem | undefined> {
		const index = await pickIndex(this.indexes);
		return index && { index, node: index.library.tree() };
	}

	/** Opens the outline or summary of a node; one that is not there yet is made first, where it will be found. */
	private async openCompanion(item: BookItem | undefined, kind: 'outline' | 'summary'): Promise<void> {
		item ??= await this.book();
		if (!item) {
			return;
		}
		const { index, node } = item;
		await createAndOpen(index.uri(node[kind] ?? joinPath(index.root(kind), ...node.dirs, `${node.name}.md`)));
	}

	/**
	 * Asks for a name, suggesting the next number, and makes an empty chapter
	 * in a level. Without a level: where the chapter being edited is, else
	 * where the book's last chapter is.
	 */
	private async newChapter(item?: BookItem): Promise<void> {
		if (!item) {
			const book = await this.book();
			if (!book) {
				return;
			}
			const active = vscode.window.activeTextEditor && book.index.relative(vscode.window.activeTextEditor.document.uri);
			item = (active === undefined ? undefined : findChapter(book, active)) ?? lastLevel(book);
		}
		const level = item.node.kind === 'chapter' ? item.parent! : item;
		const suggestion = suggestChapterName(bookOf(level).node, level.node, `${firstNamesOf(level.index).chapter} `);
		const taken = level.node.children.filter((child) => child.kind === 'chapter').map((child) => child.name);
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t('New chapter in {0}', level.node.name),
			prompt: vscode.l10n.t('The file name of the chapter. The number goes on from the last chapter; add the title.'),
			value: suggestion,
			valueSelection: [suggestion.length, suggestion.length],
			validateInput: (value) => problemText(nameProblem(value, taken)),
		});
		if (name === undefined) {
			return;
		}
		const folder = level.node.kind === 'book' ? level.index.root('chapter') : level.node.path;
		await createAndOpen(level.index.uri(joinPath(folder, `${name.trim()}.md`)));
	}

	/**
	 * Makes a level (a volume in the book, an arc in a volume) with its first
	 * chapter: a level is a folder that holds chapters, so it starts with one.
	 */
	private async newLevel(item?: BookItem): Promise<void> {
		const parent = item ?? (await this.book());
		if (!parent) {
			return;
		}
		const book = bookOf(parent).node;
		const suggestion = suggestLevelName(book, parent.node, `${firstNamesOf(parent.index).volume} `);
		const taken = parent.node.children.filter((child) => child.kind === 'level').map((child) => child.name);
		const level = await vscode.window.showInputBox({
			title: vscode.l10n.t('New volume or arc in {0}', parent.node.name),
			prompt: vscode.l10n.t('The name of its folder. Next: the name of its first chapter.'),
			value: suggestion,
			valueSelection: [suggestion.length, suggestion.length],
			validateInput: (value) => problemText(nameProblem(value, taken)),
		});
		if (level === undefined) {
			return;
		}
		const first = suggestChapterName(book, { ...parent.node, children: [] }, `${firstNamesOf(parent.index).chapter} `);
		const chapter = await vscode.window.showInputBox({
			title: vscode.l10n.t('First chapter of {0}', level.trim()),
			prompt: vscode.l10n.t('A volume or arc shows up in the tree once it has a chapter.'),
			value: first,
			valueSelection: [first.length, first.length],
			validateInput: (value) => problemText(nameProblem(value, [])),
		});
		if (chapter === undefined) {
			return;
		}
		const folder = parent.node.kind === 'book' ? parent.index.root('chapter') : parent.node.path;
		await createAndOpen(parent.index.uri(joinPath(folder, level.trim(), `${chapter.trim()}.md`)));
	}

	/** Renames a chapter or a level together with its outline and summary, as one edit that Undo takes back. */
	private async rename(item?: BookItem): Promise<void> {
		if (!item?.parent) {
			return;
		}
		const { index, node, parent } = item;
		const taken = parent.node.children.filter((child) => child.kind === node.kind && child !== node).map((child) => child.name);
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t('Rename {0}', node.name),
			prompt: vscode.l10n.t('Its outline and summary are renamed with it.'),
			value: node.name,
			validateInput: (value) => problemText(nameProblem(value, taken)),
		});
		if (name === undefined || name.trim() === node.name) {
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		for (const { from, to } of index.library.renames(node, name.trim())) {
			edit.renameFile(index.uri(from), index.uri(to));
		}
		if (!(await vscode.workspace.applyEdit(edit))) {
			void vscode.window.showErrorMessage(
				vscode.l10n.t('Could not rename {0}: is there a file or folder called {1} already?', node.name, name.trim()),
			);
		}
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
