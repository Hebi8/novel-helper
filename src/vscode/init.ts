// "Initialize Novel Workspace": makes the folders and starter files a novel
// starts from, those the writer ticks. Nothing that exists is touched.

import * as vscode from 'vscode';
import { DEFAULT_BOOK_NAMES } from '../core/library';
import { scaffold, type ScaffoldItem } from '../core/scaffold';
import { filePatterns } from './config';
import { pickIndex } from './files';
import type { WorkspaceIndexes } from './workspaceIndex';

interface Pick extends vscode.QuickPickItem {
	items: ScaffoldItem[];
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

export async function initWorkspace(indexes: WorkspaceIndexes): Promise<void> {
	const index = await pickIndex(indexes);
	if (!index) {
		return;
	}
	const t = vscode.l10n.t;
	const bookName = filePatterns(index.folder.uri).bookNames[0] ?? DEFAULT_BOOK_NAMES[0];
	const all = scaffold(
		{ chapters: index.folders('chapter'), outlines: index.folders('outline'), summaries: index.folders('summary'), lore: index.folders('lore') },
		bookName,
		t,
	);
	const present = await Promise.all(all.map((item) => exists(index.uri(item.path))));
	const missing = all.filter((_, i) => !present[i]);
	if (!missing.length) {
		void vscode.window.showInformationMessage(t('Everything a novel workspace starts from is already here.'));
		return;
	}
	const volume = missing.filter((item) => item.firstVolume);
	const picks: Pick[] = missing
		.filter((item) => !item.firstVolume)
		.map((item) => ({
			label: item.content === undefined ? `$(folder) ${item.path}/` : `$(file) ${item.path}`,
			description: item.about,
			picked: true,
			items: [item],
		}));
	if (volume.length) {
		picks.push({
			label: `$(new-folder) ${t('A first volume')}`,
			description: volume.map((item) => item.path).join(t(', ')),
			detail: t('Tick this if the book is split into volumes. Chapters can also sit right in the chapters folder.'),
			picked: false,
			items: volume,
		});
	}
	const chosen = await vscode.window.showQuickPick(picks, {
		title: t('Initialize Novel Workspace: {0}', index.folder.name),
		placeHolder:
			all.length === missing.length
				? t('Tick what to create.')
				: t('Tick what to create. What is already there is not listed and stays as it is.'),
		canPickMany: true,
	});
	if (!chosen?.length) {
		return;
	}
	const items = chosen.flatMap((pick) => pick.items);
	const edit = new vscode.WorkspaceEdit();
	for (const item of items) {
		if (item.content === undefined) {
			await vscode.workspace.fs.createDirectory(index.uri(item.path));
		} else {
			edit.createFile(index.uri(item.path), { ignoreIfExists: true, contents: new TextEncoder().encode(item.content) });
		}
	}
	await vscode.workspace.applyEdit(edit);
	// Start where a book starts: its outline.
	const first = items.find((item) => item.content !== undefined);
	if (first) {
		await vscode.window.showTextDocument(index.uri(first.path), { preview: false });
	}
}
