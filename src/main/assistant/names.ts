import { join } from 'node:path';
import type { BookIndex } from '../book/indexer';
import { readOptional } from '../book/files';
import { globFolders } from '../../core/library';
import type { StoryNames } from '../../core/scaffold';
import { MARKER_FILE, namesLanguageOf, parseMarker } from '../../core/story';
import { defaults } from '../../shared/defaults';

/** Use the same busiest roots and lore-folder order as the extension's brief. */
export async function storyNames(index: BookIndex): Promise<StoryNames> {
	const marker = parseMarker((await readOptional(join(index.root, MARKER_FILE))) ?? '');
	const chapters = index.library.roots('chapter')[0] ?? defaults['files.chapters'].flatMap(globFolders)[0];
	const outlines = index.library.roots('outline')[0] ?? defaults['files.outlines'].flatMap(globFolders)[0];
	const summaries = index.library.roots('summary')[0] ?? defaults['files.summaries'].flatMap(globFolders)[0];
	const knownLore = defaults['files.lore'].flatMap(globFolders);
	const usedLore = knownLore.filter((folder) => index.library.entries().some((entry) => entry.id.startsWith(`${folder}/`)));
	const lore = usedLore.length ? usedLore : marker?.folders?.lore?.length ? marker.folders.lore : knownLore.slice(0, 1);
	return {
		language: marker?.language ?? namesLanguageOf([chapters, outlines, ...lore].join('')),
		chapters,
		outlines,
		summaries,
		lore,
		book: index.library.tree().name,
	};
}
