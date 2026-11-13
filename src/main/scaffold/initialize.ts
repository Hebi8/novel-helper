import { join } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { globFolders } from '../../core/library';
import { markerOf, scaffold, storyNames } from '../../core/scaffold';
import { MARKER_FILE, serializeMarker, type NamesLanguage } from '../../core/story';
import type { Settings } from '../../shared/defaults';
import { BookIndex, findStories } from '../book/indexer';
import { bookNames } from '../book/names';
import { createFile, info, safePath } from './disk';
import { zh, translateReport } from '../../renderer/strings';
export async function initialization(root: string, language: NamesLanguage, settings: Settings) {
	const names = storyNames(
		{
			chapters: settings['files.chapters'].flatMap(globFolders),
			outlines: settings['files.outlines'].flatMap(globFolders),
			summaries: settings['files.summaries'].flatMap(globFolders),
			lore: settings['files.lore'].flatMap(globFolders),
		},
		settings['files.bookNames'],
		language,
	);
	const items = scaffold(names, translateReport);
	const present = await Promise.all(items.map(async (item) => !!(await info(await safePath(root, item.path)))));
	return { names, items: items.filter((_, i) => !present[i]) };
}
export async function initialize(root: string, language: NamesLanguage, selected: string[], settings: Settings): Promise<void> {
	root = await realpath(root);
	const { names, items } = await initialization(root, language, settings);
	for (const item of items.filter((item) => selected.includes(item.path))) {
		if (item.content === undefined) {
			await mkdir(await safePath(root, item.path), { recursive: true });
		} else {
			await createFile(root, item.path, item.content);
		}
	}
	if (!(await info(join(root, MARKER_FILE)))) {
		await createFile(root, MARKER_FILE, serializeMarker(markerOf(names)));
	}
}
export async function markExisting(index: BookIndex): Promise<boolean> {
	if (index.library.empty) {
		return false;
	}
	const marker = markerOf(bookNames(index));
	await createFile(index.root, MARKER_FILE, serializeMarker(marker));
	index.marker = marker;
	return true;
}
/** root is canonicalized by the window's open flow before checking for an existing window. */
export async function prepareOpen(
	root: string,
	settings: Settings,
): Promise<{ root: string; index?: BookIndex; roots?: string[]; initialize?: boolean }> {
	const index = new BookIndex(root, settings);
	await index.load();
	if (index.marker) {
		return { root, index };
	}
	if (await info(join(root, MARKER_FILE))) {
		throw new Error(zh.invalidMarker);
	}
	if (await markExisting(index)) {
		return { root, index };
	}
	index.dispose();
	const roots = await findStories(root);
	return roots.length ? { root, roots } : { root, initialize: true };
}
