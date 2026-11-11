// The sidebar's tree of the book: the book, its volumes and arcs, its
// chapters. It lays out what is there and makes the files; what goes in them
// is written in the editor.

import * as vscode from 'vscode';
import { nameProblem, suggestChapterName, suggestLevelName } from '../core/book';
import type { BookNode } from '../core/library';
import { createAndOpen, joinPath, pickIndex, problemText } from './files';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

export interface BookItem {
	index: FolderIndex;
	node: BookNode;
	/** Undefined for the book itself. */
	parent?: BookItem;
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

export class BookView implements vscode.TreeDataProvider<BookItem>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly view: vscode.TreeView<BookItem>;
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
				// A chapter just made is opened before the index has it.
				void this.revealActive();
			}),
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
	}

	/** One book per open folder that has anything of a novel in it. */
	private async books(): Promise<BookItem[]> {
		const indexes = await this.indexes.all();
		return indexes.filter((index) => !index.library.empty).map((index) => ({ index, node: index.library.tree() }));
	}

	async getChildren(item?: BookItem): Promise<BookItem[]> {
		return item ? childrenOf(item) : this.books();
	}

	getParent(item: BookItem): BookItem | undefined {
		return item.parent;
	}

	getTreeItem({ index, node }: BookItem): vscode.TreeItem {
		const t = vscode.l10n.t;
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
			item.description = [folders.length > 1 ? index.folder.name : '', t('{0} chapters', count(node)), outline].filter(Boolean).join(' · ');
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
			if (vscode.workspace.getWorkspaceFolder(uri) === book.index.folder) {
				const chapter = findChapter(book, book.index.relative(uri));
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
			const editor = vscode.window.activeTextEditor;
			item = (editor && findChapter(book, book.index.relative(editor.document.uri))) ?? lastLevel(book);
		}
		const level = item.node.kind === 'chapter' ? item.parent! : item;
		const suggestion = suggestChapterName(bookOf(level).node, level.node, `${vscode.l10n.t('Chapter 1')} `);
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
		const suggestion = suggestLevelName(book, parent.node, `${vscode.l10n.t('Volume 1')} `);
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
		const first = suggestChapterName(book, { ...parent.node, children: [] }, `${vscode.l10n.t('Chapter 1')} `);
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
