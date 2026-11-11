// "Initialize Novel Workspace": asks where the story goes and whether its
// folders get Chinese or English names, makes the folders and starter files
// the writer ticks, leaves the marker, and points the story folder setting
// there. Nothing that exists is touched.

import * as vscode from 'vscode';
import { DEFAULT_BOOK_NAMES } from '../core/library';
import { markerOf, scaffold, type ScaffoldItem, storyNames } from '../core/scaffold';
import { type NamesLanguage, normalizeStoryFolder } from '../core/story';
import { filePatterns, setStoryFolder } from './config';
import { pickFolder, staysInside } from './files';
import { displayNamesLanguage, readMarker, storyLabel, writeMarker } from './story';
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
	const folder = await pickFolder();
	if (!folder) {
		return;
	}
	const t = vscode.l10n.t;
	const index = await indexes.get(folder);

	const where = await vscode.window.showInputBox({
		title: t('Initialize Novel Workspace: where'),
		prompt: t('The story folder, as a path relative to the workspace folder {0}. Empty for the workspace folder itself. A folder that is not there is made.', folder.name),
		value: index.story ?? '',
		validateInput: (value) => (normalizeStoryFolder(value) === undefined ? t('It has to be a path inside the workspace folder: not absolute, no "..".') : undefined),
	});
	const story = where === undefined ? undefined : normalizeStoryFolder(where);
	if (story === undefined) {
		return;
	}
	const root = story ? vscode.Uri.joinPath(folder.uri, ...story.split('/')) : folder.uri;
	const uri = (path: string) => vscode.Uri.joinPath(root, ...path.split('/'));

	// A story that was initialized before keeps the names it has.
	const marked = await readMarker(root);
	const languages: Array<vscode.QuickPickItem & { language: NamesLanguage }> = [
		{ label: t('Chinese names'), description: '正文、大纲、摘要、设定、人物、资料', language: 'zh' },
		{ label: t('English names'), description: 'chapters, outlines, summaries, lore, characters, worldbuilding', language: 'en' },
	];
	const language =
		marked?.language ??
		(
			await vscode.window.showQuickPick(
				languages.sort((a, b) => Number(b.language === displayNamesLanguage()) - Number(a.language === displayNamesLanguage())),
				{
					title: t('Initialize Novel Workspace: {0}', storyLabel(story)),
					placeHolder: t('Which names should the folders and starter files get? Both are recognized later.'),
				},
			)
		)?.language;
	if (!language) {
		return;
	}

	const patterns = filePatterns(folder.uri);
	const names = storyNames(
		{ chapters: index.folders('chapter'), outlines: index.folders('outline'), summaries: index.folders('summary'), lore: index.folders('lore') },
		patterns.bookNames.length ? patterns.bookNames : DEFAULT_BOOK_NAMES,
		language,
	);
	const all = scaffold(names, t);
	if (!staysInside(all.map((item) => item.path))) {
		return;
	}
	const present = await Promise.all(all.map((item) => exists(uri(item.path))));
	const missing = all.filter((_, i) => !present[i]);
	let chosen: ScaffoldItem[] = [];
	if (missing.length) {
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
		const ticked = await vscode.window.showQuickPick(picks, {
			title: t('Initialize Novel Workspace: {0}', storyLabel(story)),
			placeHolder:
				all.length === missing.length
					? t('Tick what to create.')
					: t('Tick what to create. What is already there is not listed and stays as it is.'),
			canPickMany: true,
		});
		if (!ticked) {
			return;
		}
		chosen = ticked.flatMap((pick) => pick.items);
	}

	const edit = new vscode.WorkspaceEdit();
	for (const item of chosen) {
		if (item.content === undefined) {
			await vscode.workspace.fs.createDirectory(uri(item.path));
		} else {
			edit.createFile(uri(item.path), { ignoreIfExists: true, contents: new TextEncoder().encode(item.content) });
		}
	}
	await vscode.workspace.applyEdit(edit);
	if (!marked) {
		await writeMarker(root, markerOf(names));
	}
	if (story !== index.story) {
		await setStoryFolder(folder, story);
	}
	// The marker and the new folders are not all things the watchers report.
	indexes.reset();
	if (!missing.length) {
		void vscode.window.showInformationMessage(
			marked
				? t('Everything a novel workspace starts from is already here.')
				: t('Everything was already here. {0} is now marked as an initialized story folder.', storyLabel(story)),
		);
	}
	// Start where a book starts: its outline.
	const first = chosen.find((item) => item.content !== undefined);
	if (first) {
		await vscode.window.showTextDocument(uri(first.path), { preview: false });
	}
}
