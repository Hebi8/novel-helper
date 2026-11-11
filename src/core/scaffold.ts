// What "Initialize Novel Workspace" offers to create in an empty folder.

import type { Translate } from './report';

export interface ScaffoldItem {
	/** Relative to the workspace folder. */
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

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

/**
 * The folders and starter files of a novel workspace: the first folder of
 * each setting (正文, 大纲, 摘要, 设定), 人物 and 资料 when the lore setting
 * has them, the whole book's outline, an always-on style entry, and a first
 * volume with its first chapter and outline. Starter files hold headings
 * only; the writing is the writer's.
 */
export function scaffold(folders: ScaffoldFolders, bookName: string, t: Translate): ScaffoldItem[] {
	const chapters = folders.chapters[0] ?? '';
	const outlines = folders.outlines[0] ?? '';
	const lore = folders.lore[0] ?? '';
	const volume = t('Volume 1');
	const style = t('Style');
	const items: ScaffoldItem[] = [
		{ path: chapters, about: t('chapters, one file each') },
		{ path: outlines, about: t('outlines: of the book, of each volume, of each chapter') },
		{ path: folders.summaries[0] ?? '', about: t('chapter summaries, sent in place of earlier chapters') },
		{ path: lore, about: t('lore entries, one file each') },
		...['人物', '资料']
			.filter((name) => name !== lore && folders.lore.includes(name))
			.map((name) => ({ path: name, about: t('lore entries, one file each') })),
		{
			path: join(outlines, `${bookName}.md`),
			about: t('outline of the whole book, sent with every request'),
			content: `# ${t('Outline of the whole book')}\n\n## ${t('In one sentence')}\n\n## ${t('Main plot')}\n\n## ${t('Volumes')}\n`,
		},
		{
			path: join(lore, `${style}.md`),
			about: t('an always-on entry for the style to write in'),
			content: `---\ntype: ${style}\nalways: true\n---\n\n## ${t('Person and tense')}\n\n## ${t('Language')}\n\n## ${t('Never')}\n`,
		},
		{ path: join(chapters, volume, `${t('Chapter 1')}.md`), about: t('the first chapter of a first volume'), content: '', firstVolume: true },
		{ path: join(outlines, `${volume}.md`), about: t('outline of the first volume'), content: '', firstVolume: true },
	];
	// A setting that roots its files in the workspace folder itself has no folder to make.
	return items.filter((item) => item.path !== '');
}
