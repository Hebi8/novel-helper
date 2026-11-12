// The story folder of a workspace folder: finding the ones that have been
// initialized, reading and writing their marker, and switching between them.

import * as vscode from 'vscode';
import { type Marker, MARKER_FILE, MARKER_GLOBS, MARKER_VERSION, type NamesLanguage, namesLanguageOf, normalizeStoryFolder, parseMarker, relativeInside, SCAN_EXCLUDE, serializeMarker, storiesFromMarkers } from '../core/story';
import { setStoryFolder } from './config';
import { pickFolder } from './files';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

/** More story folders than this in one workspace folder are not listed. */
const MAX_STORIES = 50;

function markerUri(story: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(story, ...MARKER_FILE.split('/'));
}

/** What the marker file of a story folder holds; undefined when it has none, or one that cannot be read as a marker. */
export async function readMarker(story: vscode.Uri): Promise<Marker | undefined> {
	try {
		return parseMarker(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(markerUri(story))));
	} catch {
		return undefined;
	}
}

export async function writeMarker(story: vscode.Uri, marker: Marker): Promise<void> {
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(markerUri(story), '..'));
	await vscode.workspace.fs.writeFile(markerUri(story), new TextEncoder().encode(serializeMarker(marker)));
}

/**
 * The initialized story folders of a workspace folder other than `current`,
 * as paths below it: found by their marker files, a few folders deep, not
 * in dependencies or hidden folders.
 */
export async function findStories(folder: vscode.WorkspaceFolder, current?: string): Promise<string[]> {
	const base = folder.uri.path.replace(/\/$/, '');
	// The depth limit and the folders to stay out of are part of the search; the cap is on what is left after filtering.
	const found = (await Promise.all(MARKER_GLOBS.map((glob) => vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), SCAN_EXCLUDE)))).flat();
	const stories = storiesFromMarkers(found.map((uri) => uri.path.slice(base.length + 1)), current).slice(0, MAX_STORIES);
	const marked = await Promise.all(stories.map((story) => readMarker(story ? vscode.Uri.joinPath(folder.uri, ...story.split('/')) : folder.uri)));
	return stories.filter((_, i) => marked[i] !== undefined);
}

/** Chinese names where VS Code is shown in Chinese, else English ones. */
export function displayNamesLanguage(): NamesLanguage {
	return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** How a story folder is shown: its path, or a word for the workspace folder itself. */
export function storyLabel(story: string): string {
	return story || vscode.l10n.t('(workspace folder)');
}

/** The marker for a story folder that was laid out by hand or by an earlier version: the folders it uses. */
export function markerOfIndex(index: FolderIndex): Marker {
	const lore = index.folders('lore').filter((folder) => folder && index.library.entries().some((entry) => entry.id.startsWith(`${folder}/`)));
	const chapters = index.root('chapter');
	return {
		version: MARKER_VERSION,
		language: namesLanguageOf([chapters, index.root('outline'), ...lore].join('')),
		folders: { chapters, outlines: index.root('outline'), summaries: index.root('summary'), lore },
		book: index.library.tree().name,
	};
}

interface Choice extends vscode.QuickPickItem {
	run(): Promise<string | undefined> | string | undefined;
}

/**
 * "Select Story Folder": one of the story folders found, a folder picked in
 * a dialog, a path typed in, or back to the workspace folder itself; and,
 * for a story folder that works without a marker, adding the marker.
 */
export async function selectStoryFolder(indexes: WorkspaceIndexes, preselected?: vscode.WorkspaceFolder): Promise<void> {
	const folder = preselected ?? (await pickFolder());
	if (!folder) {
		return;
	}
	const t = vscode.l10n.t;
	const index = await indexes.get(folder);
	const others = await findStories(folder, index.story);
	const choices: Choice[] = others.map((story) => ({
		label: `$(book) ${storyLabel(story)}`,
		description: t('initialized story folder'),
		run: () => story,
	}));
	choices.push(
		{
			label: `$(folder-opened) ${t('Pick a folder…')}`,
			description: t('a folder inside {0}', folder.name),
			run: async () => {
				const [picked] = (await vscode.window.showOpenDialog({ defaultUri: index.storyUri, canSelectFolders: true, canSelectFiles: false, openLabel: t('Use as Story Folder') })) ?? [];
				if (!picked) {
					return undefined;
				}
				const inside = relativeInside(folder.uri.path, picked.path);
				if (inside === undefined) {
					void vscode.window.showErrorMessage(t('The story folder has to be inside the workspace folder {0}.', folder.name));
				}
				return inside;
			},
		},
		{
			label: `$(edit) ${t('Type a path…')}`,
			description: t('relative to {0}', folder.name),
			run: async () => {
				const typed = await vscode.window.showInputBox({
					title: t('Story folder'),
					prompt: t('A path relative to the workspace folder {0}. Empty for the workspace folder itself.', folder.name),
					value: index.story ?? '',
					validateInput: (value) => (normalizeStoryFolder(value) === undefined ? t('It has to be a path inside the workspace folder: not absolute, no "..".') : undefined),
				});
				return typed === undefined ? undefined : normalizeStoryFolder(typed);
			},
		},
	);
	if (index.story !== '' && !others.includes('')) {
		choices.push({ label: `$(root-folder) ${t('Back to the workspace folder')}`, description: folder.name, run: () => '' });
	}
	if (index.state === 'unmarked') {
		choices.push({
			label: `$(pass) ${t('Mark this folder as initialized')}`,
			description: t('writes {0}, so that it is found as a story folder', MARKER_FILE),
			run: async () => {
				await writeMarker(index.storyUri, markerOfIndex(index));
				indexes.reset();
				return undefined;
			},
		});
	}
	const choice = await vscode.window.showQuickPick(choices, {
		title: t('Story folder of {0}', folder.name),
		placeHolder: t('Now: {0}. Where is the story?', index.story === undefined ? index.storySetting : storyLabel(index.story)),
	});
	const story = await choice?.run();
	if (story !== undefined && story !== index.story) {
		await setStoryFolder(folder, story);
	}
}
