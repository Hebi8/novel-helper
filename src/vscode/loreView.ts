// The sidebar's list of lore entries, grouped by type. It changes the fixed
// frontmatter fields (always on, aliases, type) and starts new entries from
// a template; the entry itself is written in the editor.

import * as vscode from 'vscode';
import { nameProblem } from '../core/book';
import { type FieldValue, FrontmatterError, setField } from '../core/frontmatter';
import type { LoreEntry } from '../core/library';
import { builtinTemplate, fillTemplate, folderForNew, groupLore, parseAliases, templateNames } from '../core/loreGroups';
import { dirSegments, stem } from '../core/text';
import { createAndOpen, joinPath, pickIndex, problemText } from './files';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

/** Where a workspace keeps its own templates for new entries: one file per type, `default.md` for the rest. */
export const TEMPLATES_FOLDER = '.novel-helper/templates';

export interface LoreItem {
	index: FolderIndex;
	type: string;
	/** A group's entries; undefined for an entry. */
	entries?: LoreEntry[];
	/** Undefined for a group. */
	entry?: LoreEntry;
}

export class LoreView implements vscode.TreeDataProvider<LoreItem>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[];

	constructor(private readonly indexes: WorkspaceIndexes) {
		const command = (id: string, run: (item?: LoreItem) => Promise<void>) => vscode.commands.registerCommand(id, run);
		this.disposables = [
			this.changed,
			vscode.window.registerTreeDataProvider('novelHelper.lore', this),
			indexes.onDidChange(() => this.changed.fire()),
			command('novelHelper.lore.new', (item) => this.newEntry(item)),
			command('novelHelper.lore.pin', (item) => this.set(item, 'always', true)),
			command('novelHelper.lore.unpin', (item) => this.set(item, 'always', false)),
			command('novelHelper.lore.setAliases', (item) => this.setAliases(item)),
			command('novelHelper.lore.setType', (item) => this.setType(item)),
		];
	}

	async getChildren(item?: LoreItem): Promise<LoreItem[]> {
		if (item) {
			return (item.entries ?? []).map((entry) => ({ index: item.index, type: item.type, entry }));
		}
		const indexes = await this.indexes.all();
		return indexes.flatMap((index) => groupLore(index.library.entries()).map((group) => ({ index, type: group.type, entries: group.entries })));
	}

	getTreeItem({ index, type, entries, entry }: LoreItem): vscode.TreeItem {
		const t = vscode.l10n.t;
		const folder = index.folder.uri.toString();
		if (!entry) {
			const item = new vscode.TreeItem(type || t('(no type)'), vscode.TreeItemCollapsibleState.Expanded);
			item.id = `${folder}#group:${type}`;
			item.contextValue = 'group';
			const folders = vscode.workspace.workspaceFolders ?? [];
			item.description = [folders.length > 1 ? index.folder.name : '', String(entries?.length ?? 0)].filter(Boolean).join(' · ');
			return item;
		}
		const uri = index.uri(entry.id);
		const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
		item.id = `${folder}#entry:${entry.id}`;
		item.contextValue = entry.always ? 'entryAlways' : 'entry';
		item.resourceUri = uri;
		item.iconPath = entry.error ? new vscode.ThemeIcon('warning') : entry.always ? new vscode.ThemeIcon('pinned') : vscode.ThemeIcon.File;
		item.command = { command: 'vscode.open', title: t('Open'), arguments: [uri] };
		item.description = [
			entry.error ? t('frontmatter not valid') : '',
			entry.always ? t('always on') : '',
			entry.aliases.length ? t('aliases: {0}', entry.aliases.join(t(', '))) : '',
		]
			.filter(Boolean)
			.join(' · ');
		item.tooltip = [entry.id, entry.summary, entry.error].filter(Boolean).join('\n');
		return item;
	}

	/** Sets one frontmatter field of an entry's file and saves it; the rest of the file stays as it is. */
	private async set(item: LoreItem | undefined, key: string, value: FieldValue): Promise<void> {
		if (!item?.entry) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(item.index.uri(item.entry.id));
		const before = document.getText();
		let after: string;
		try {
			after = setField(before, key, value);
		} catch (error) {
			const why = (error instanceof Error ? error.message : String(error)).split('\n')[0];
			void vscode.window.showErrorMessage(
				error instanceof FrontmatterError && error.kind === 'unsupported'
					? vscode.l10n.t(
							'{0} was not changed: the way its frontmatter is written, this field cannot be set from here without touching a comment or another field. Change it in the file. ({1})',
							item.entry.id,
							why,
						)
					: vscode.l10n.t('Could not change {0}: its frontmatter is not valid YAML. Open the file and fix it first. ({1})', item.entry.id, why),
			);
			return;
		}
		// Only what differs is replaced, so the cursor and the undo history of an open editor stay put.
		let start = 0;
		while (start < before.length && before[start] === after[start]) {
			start++;
		}
		let end = 0;
		while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) {
			end++;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(document.positionAt(start), document.positionAt(before.length - end)),
			after.slice(start, after.length - end),
		);
		await vscode.workspace.applyEdit(edit);
		await document.save();
	}

	private async setAliases(item?: LoreItem): Promise<void> {
		if (!item?.entry) {
			return;
		}
		const separator = vscode.l10n.t(', ');
		const input = await vscode.window.showInputBox({
			title: vscode.l10n.t('Aliases of {0}', item.entry.name),
			prompt: vscode.l10n.t('Other names the text uses for this entry, separated by commas. Empty for none.'),
			value: item.entry.aliases.join(separator),
		});
		if (input !== undefined) {
			await this.set(item, 'aliases', parseAliases(input));
		}
	}

	/** A type that is in use, or a new one. */
	private async pickType(index: FolderIndex, title: string, current?: string): Promise<string | undefined> {
		const other: vscode.QuickPickItem = { label: `$(add) ${vscode.l10n.t('Another type…')}` };
		const types = groupLore(index.library.entries())
			.map((group) => group.type)
			.filter((type) => type && type !== current);
		const pick = types.length
			? await vscode.window.showQuickPick([...types.map((label): vscode.QuickPickItem => ({ label })), other], { title })
			: other;
		if (pick !== other) {
			return pick?.label;
		}
		const typed = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('The type, as it goes into the frontmatter: 人物, 地点, 功法…') });
		return typed?.trim() || undefined;
	}

	private async setType(item?: LoreItem): Promise<void> {
		if (!item?.entry) {
			return;
		}
		const type = await this.pickType(item.index, vscode.l10n.t('Type of {0}', item.entry.name), item.type);
		if (type) {
			await this.set(item, 'type', type);
		}
	}

	/**
	 * The content of a new entry: from the story folder's own template for its type, else its `default.md`, else the
	 * built-in one. Undefined, after saying why, when a template is there but cannot be filled in.
	 */
	private async content(index: FolderIndex, path: string, name: string, type: string): Promise<string | undefined> {
		for (const template of templateNames(type)) {
			const file = `${TEMPLATES_FOLDER}/${template}.md`;
			let text: string;
			try {
				text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(index.uri(file)));
			} catch {
				// No such template: try the next.
				continue;
			}
			try {
				return fillTemplate(text, path, name, type);
			} catch (error) {
				void vscode.window.showErrorMessage(
					vscode.l10n.t(
						'No entry was created: with the name and type filled in, the frontmatter of the template {0} is not valid YAML. ({1})',
						file,
						(error instanceof Error ? error.message : String(error)).split('\n')[0],
					),
				);
				return undefined;
			}
		}
		return builtinTemplate(type, vscode.l10n.t);
	}

	/** Asks for a type (unless started from a group) and a name, then makes the entry from the type's template and opens it. */
	private async newEntry(item?: LoreItem): Promise<void> {
		const index = item?.index ?? (await pickIndex(this.indexes));
		if (!index) {
			return;
		}
		const type = item?.type ?? (await this.pickType(index, vscode.l10n.t('New lore entry: its type')));
		if (type === undefined) {
			return;
		}
		const entries = index.library.entries();
		const folder = folderForNew(type, entries, index.folders('lore'));
		const taken = entries.filter((entry) => dirSegments(entry.id).join('/') === folder).map((entry) => stem(entry.id));
		const name = await vscode.window.showInputBox({
			title: type ? vscode.l10n.t('New lore entry of type {0}', type) : vscode.l10n.t('New lore entry'),
			prompt: vscode.l10n.t('Its name, which is also its file name: {0}', joinPath(folder, vscode.l10n.t('name.md'))),
			validateInput: (value) => problemText(nameProblem(value, taken)),
		});
		if (name === undefined) {
			return;
		}
		const path = joinPath(folder, `${name.trim()}.md`);
		const content = await this.content(index, path, name.trim(), type);
		if (content !== undefined) {
			await createAndOpen(index, path, content);
		}
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
