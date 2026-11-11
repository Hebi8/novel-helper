// What "Initialize Novel Workspace" offers to create in a story folder, with
// Chinese or English names, and the marker it leaves there.

import type { Translate } from './report';
import { MARKER_VERSION, type Marker, type NamesLanguage, namesLanguageOf } from './story';

export interface ScaffoldItem {
	/** Relative to the story folder. */
	path: string;
	/** Content of a file; undefined for a folder. */
	content?: string;
	/** What it is for, shown next to the path. */
	about: string;
	/** Part of the first volume, which is only made when asked for. */
	firstVolume?: boolean;
}

/** The folders of the settings for each kind of file, in the order written; see `globFolders`. */
export interface ScaffoldFolders {
	chapters: readonly string[];
	outlines: readonly string[];
	summaries: readonly string[];
	lore: readonly string[];
}

/** The names a story is set up with. */
export interface StoryNames {
	language: NamesLanguage;
	chapters: string;
	outlines: string;
	summaries: string;
	/** The first is where the style entry goes. */
	lore: string[];
	/** File name (extension aside) of the whole book's outline. */
	book: string;
}

const WORDS = {
	zh: {
		chapters: '正文',
		outlines: '大纲',
		summaries: '摘要',
		lore: ['设定', '人物', '资料'],
		book: '全书',
		style: '文风',
		volume: '第一卷',
		chapter: '第1章',
		bookOutline: ['全书大纲', '一句话', '主线', '分卷'],
		styleHeadings: ['人称和时态', '语言', '不要写的'],
	},
	en: {
		chapters: 'chapters',
		outlines: 'outlines',
		summaries: 'summaries',
		lore: ['lore', 'characters', 'worldbuilding'],
		book: 'book',
		style: 'Style',
		volume: 'Volume 1',
		chapter: 'Chapter 1',
		bookOutline: ['Outline of the whole book', 'In one sentence', 'Main plot', 'Volumes'],
		styleHeadings: ['Person and tense', 'Language', 'Never'],
	},
};

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

/** The names to start the first volume and the first chapter of a story with. */
export function firstNames(language: NamesLanguage): { volume: string; chapter: string } {
	return { volume: WORDS[language].volume, chapter: WORDS[language].chapter };
}

/** The usual name if the settings know it, else the first name of the settings in that language, else their first. */
function pick(known: readonly string[], usual: string, language: NamesLanguage): string {
	return known.includes(usual) ? usual : (known.find((name) => name !== '' && namesLanguageOf(name) === language) ?? known[0] ?? '');
}

/**
 * The folder and file names for a new story in a language, out of the names
 * the settings recognize (`folders` per kind of file, `bookNames` for the
 * book's outline): 正文, 大纲, 摘要, 设定 with 人物 and 资料, 全书; or
 * chapters, outlines, summaries, lore with characters and worldbuilding, book.
 */
export function storyNames(folders: ScaffoldFolders, bookNames: readonly string[], language: NamesLanguage): StoryNames {
	const words = WORDS[language];
	const lore = words.lore.filter((name) => folders.lore.includes(name));
	return {
		language,
		chapters: pick(folders.chapters, words.chapters, language),
		outlines: pick(folders.outlines, words.outlines, language),
		summaries: pick(folders.summaries, words.summaries, language),
		lore: lore.length ? lore : [pick(folders.lore, words.lore[0], language)],
		book: pick(bookNames, words.book, language) || words.book,
	};
}

/** The marker to leave in a story folder set up with these names. */
export function markerOf(names: StoryNames): Marker {
	return {
		version: MARKER_VERSION,
		language: names.language,
		folders: { chapters: names.chapters, outlines: names.outlines, summaries: names.summaries, lore: names.lore },
		book: names.book,
	};
}

/**
 * The folders and starter files of a story: a folder for chapters, outlines,
 * summaries and each kind of lore, the whole book's outline, an always-on
 * style entry, and a first volume with its first chapter and outline.
 * Starter files hold headings only, in the language of the names; the
 * writing is the writer's. `t` words what each item is for.
 */
export function scaffold(names: StoryNames, t: Translate): ScaffoldItem[] {
	const words = WORDS[names.language];
	const [title, ...parts] = words.bookOutline;
	const items: ScaffoldItem[] = [
		{ path: names.chapters, about: t('chapters, one file each') },
		{ path: names.outlines, about: t('outlines: of the book, of each volume, of each chapter') },
		{ path: names.summaries, about: t('chapter summaries, sent in place of earlier chapters') },
		...names.lore.map((path) => ({ path, about: t('lore entries, one file each') })),
		{
			path: join(names.outlines, `${names.book}.md`),
			about: t('outline of the whole book, sent with every request'),
			content: `# ${title}\n\n${parts.map((part) => `## ${part}\n`).join('\n')}`,
		},
		{
			path: join(names.lore[0], `${words.style}.md`),
			about: t('an always-on entry for the style to write in'),
			content: `---\ntype: ${words.style}\nalways: true\n---\n\n${words.styleHeadings.map((heading) => `## ${heading}\n`).join('\n')}`,
		},
		{ path: join(names.chapters, words.volume, `${words.chapter}.md`), about: t('the first chapter of a first volume'), content: '', firstVolume: true },
		{ path: join(names.outlines, `${words.volume}.md`), about: t('outline of the first volume'), content: '', firstVolume: true },
	];
	// A setting that roots its files in the story folder itself has no folder to make.
	return items.filter((item) => item.path !== '');
}
