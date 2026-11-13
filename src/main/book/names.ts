import { globFolders, type FileKind } from '../../core/library';
import { namesLanguageOf } from '../../core/story';
import type { StoryNames } from '../../core/scaffold';
import type { BookIndex } from './indexer';
const keys = { chapter: 'chapters', outline: 'outlines', summary: 'summaries' } as const;
export function bookFolder(index: BookIndex, kind: FileKind): string {
	const key = keys[kind];
	return index.library.roots(kind)[0] ?? index.marker?.folders?.[key] ?? index.configuration[`files.${key}`].flatMap(globFolders)[0];
}
export function bookNames(index: BookIndex): StoryNames {
	const chapters = bookFolder(index, 'chapter'),
		outlines = bookFolder(index, 'outline');
	const knownLore = index.configuration['files.lore'].flatMap(globFolders);
	const usedLore = knownLore.filter((folder) => index.library.entries().some((entry) => entry.id.startsWith(`${folder}/`)));
	const lore = usedLore.length ? usedLore : index.marker?.folders?.lore?.length ? index.marker.folders.lore : knownLore.slice(0, 1);
	return {
		language: index.marker?.language ?? namesLanguageOf([chapters, outlines, ...lore].join('')),
		chapters,
		outlines,
		summaries: bookFolder(index, 'summary'),
		lore,
		book: index.book.tree.name,
	};
}
