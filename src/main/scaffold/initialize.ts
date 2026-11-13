import { join } from 'node:path';
import { mkdir, realpath, readdir } from 'node:fs/promises';
import { globFolders } from '../../core/library';
import { markerOf, scaffold, storyNames } from '../../core/scaffold';
import { MARKER_FILE, MARKER_VERSION, namesLanguageOf, parseMarker, serializeMarker, type NamesLanguage } from '../../core/story';
import { defaults, type Settings } from '../../shared/defaults';
import { readOptional } from '../book/files';
import { BookIndex, findStories } from '../book/indexer';
import { createFile, info, safePath } from './disk';
import { zh, translateReport } from '../../renderer/strings';

export async function initialization(root: string, language: NamesLanguage, settings: Settings = defaults) {
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
export async function initialize(root: string, language: NamesLanguage, selected: string[], settings: Settings = defaults): Promise<void> {
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
/** Default folders from older workspaces keep their inferred names, without adding starter files. */
export async function markExisting(root: string, settings: Settings = defaults): Promise<boolean> {
	const folders = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const kinds = ['chapters', 'outlines', 'summaries', 'lore'] as const;
	if (!kinds.some((kind) => settings[`files.${kind}`].flatMap(globFolders).some((folder) => folders.includes(folder)))) {
		return false;
	}
	const index = new BookIndex(root, settings);
	await index.load();
	const used = (kind: 'chapter' | 'outline' | 'summary', key: 'chapters' | 'outlines' | 'summaries') =>
		index.library.roots(kind)[0] ??
		settings[`files.${key}`].flatMap(globFolders).find((folder) => folders.includes(folder)) ??
		settings[`files.${key}`].flatMap(globFolders)[0];
	const chapters = used('chapter', 'chapters'),
		outlines = used('outline', 'outlines');
	const lore = settings['files.lore'].flatMap(globFolders).filter((folder) => folders.includes(folder));
	await createFile(
		root,
		MARKER_FILE,
		serializeMarker({
			version: MARKER_VERSION,
			language: namesLanguageOf([chapters, outlines, ...lore].join('')),
			folders: { chapters, outlines, summaries: used('summary', 'summaries'), lore },
			book: index.book.tree.name,
		}),
	);
	index.dispose();
	return true;
}
export async function prepareOpen(
	root: string,
	settings: Settings = defaults,
): Promise<{ root: string; roots?: string[]; initialize?: boolean }> {
	root = await realpath(root);
	const marker = await readOptional(join(root, MARKER_FILE));
	if (marker !== undefined && parseMarker(marker)) {
		return { root };
	}
	if (marker !== undefined) {
		throw new Error(zh.invalidMarker);
	}
	const roots = await findStories(root);
	if (roots.length) {
		return { root, roots };
	}
	if (marker === undefined && (await markExisting(root, settings))) {
		return { root };
	}
	return { root, initialize: true };
}
