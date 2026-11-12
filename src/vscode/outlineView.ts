// The sidebar's tree of the outline graph: folders, files and headings as
// they nest, with the links between them and where the chapter last in the
// editor is. The buoys are moved from here; the outline itself is written in
// the files a click opens.

import * as vscode from 'vscode';
import { ancestors, type OutlineNode, trail } from '../core/outline';
import { isUsable } from '../core/story';
import { stem } from '../core/text';
import { type Buoys, type ChapterPosition, positionSummary, roleOf } from './buoys';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

export interface OutlineItem {
	index: FolderIndex;
	node: OutlineNode;
	/** Where the chapter last in the editor is, when it is a chapter of this folder. */
	at?: ChapterPosition;
}

export class OutlineView implements vscode.TreeDataProvider<OutlineItem>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly view: vscode.TreeView<OutlineItem>;
	private readonly disposables: vscode.Disposable[];

	constructor(
		private readonly indexes: WorkspaceIndexes,
		private readonly buoys: Buoys,
	) {
		this.view = vscode.window.createTreeView('novelHelper.outline', { treeDataProvider: this, showCollapseAll: true });
		const onNode = (id: string, move: 'in' | 'bridge' | 'parallel') =>
			vscode.commands.registerCommand(id, (item?: OutlineItem) => (item ? buoys.put(item.node.id, move) : undefined));
		const refresh = () => {
			this.changed.fire();
			void this.describe();
		};
		this.disposables = [
			this.changed,
			this.view,
			// Also fires after the index changed: the chapter is looked up again then.
			buoys.onDidChange(refresh),
			onNode('novelHelper.outline.placeHere', 'in'),
			onNode('novelHelper.outline.bridgeTo', 'bridge'),
			onNode('novelHelper.outline.addParallel', 'parallel'),
			vscode.commands.registerCommand('novelHelper.outline.dropSecond', () => buoys.dropSecond()),
			vscode.commands.registerCommand('novelHelper.position.forward', () => buoys.move('forward')),
			vscode.commands.registerCommand('novelHelper.position.back', () => buoys.move('back')),
			vscode.commands.registerCommand('novelHelper.position.relocate', () => buoys.relocate()),
		];
		void this.describe();
	}

	/** Above the tree: the chapter last in the editor and where it is. */
	private async describe(): Promise<void> {
		const at = await this.buoys.current();
		this.view.message = at
			? vscode.l10n.t('{0}: {1}', stem(at.chapter), positionSummary(at) ?? vscode.l10n.t('no position on the outline yet'))
			: undefined;
	}

	/** One tree per folder that has something in its outline, the book at its top. */
	async getChildren(item?: OutlineItem): Promise<OutlineItem[]> {
		if (item) {
			return item.node.children.map((node) => ({ index: item.index, node, at: item.at }));
		}
		const current = await this.buoys.current();
		const tops: OutlineItem[] = [];
		for (const index of await this.indexes.all()) {
			if (!isUsable(index.state)) {
				continue;
			}
			// Where the chapter is and the tree come from the same reading of the outline, so that the nodes are the same objects.
			const at = current?.index === index ? current : undefined;
			const graph = at?.graph ?? (await index.outline());
			if (graph.leaves.length) {
				tops.push({ index, node: graph.root, at });
			}
		}
		return tops;
	}

	getParent(item: OutlineItem): OutlineItem | undefined {
		return item.node.parent && { index: item.index, node: item.node.parent, at: item.at };
	}

	getTreeItem({ index, node, at }: OutlineItem): vscode.TreeItem {
		const t = vscode.l10n.t;
		const role = roleOf(at, node);
		const holdsBuoy = at?.position?.nodes.some((buoy) => ancestors(buoy).includes(node)) ?? false;
		const item = new vscode.TreeItem(
			node.title,
			!node.children.length
				? vscode.TreeItemCollapsibleState.None
				: node.kind === 'book' || holdsBuoy
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.id = `${index.folder.uri.toString()}#outline:${node.id}`;
		// The second of two buoys can be taken away again.
		item.contextValue = role === 'to' || (role === 'parallel' && at!.position!.nodes[1] === node) ? 'outlineSecond' : 'outlineNode';
		const broken = node.links.filter((link) => !link.target);
		const roles = { in: t('◉ the chapter is here'), from: t('◉ the chapter is leaving here'), to: t('→ the chapter is heading here'), parallel: t('◉ the chapter is here too') };
		item.description = [
			role ? roles[role] : '',
			...node.links.map((link) =>
				link.target
					? `→ ${link.target.title}`
					: link.problem === 'ambiguous'
						? t('→ {0}: several nodes have this title; write it as path#title', link.raw)
						: t('→ {0}: no such node', link.raw),
			),
		]
			.filter(Boolean)
			.join(' · ');
		item.iconPath = broken.length
			? new vscode.ThemeIcon('warning')
			: role === 'to'
				? new vscode.ThemeIcon('arrow-right')
				: role
					? new vscode.ThemeIcon('location')
					: node.kind === 'book'
						? new vscode.ThemeIcon('book')
						: node.kind === 'folder'
							? vscode.ThemeIcon.Folder
							: node.kind === 'file'
								? vscode.ThemeIcon.File
								: new vscode.ThemeIcon('circle-outline');
		if (node.file !== undefined) {
			const place = new vscode.Position(node.line, 0);
			item.command = { command: 'vscode.open', title: t('Open'), arguments: [index.uri(node.file), { selection: new vscode.Range(place, place) }] };
		}
		item.tooltip = [trail(node), node.text].filter(Boolean).join('\n\n');
		return item;
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
