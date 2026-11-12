// What the assistant is told: once per session, how the story folder is laid
// out and what it may change there; and with every message, what the writer
// has open and selected. Worded in Chinese or in English, after the names
// the story's folders were given, and with those names.

import type { StoryNames } from './scaffold';
import type { NamesLanguage } from './story';

const code = (name: string) => `\`${name}\``;

/** The session's brief on the workspace. `names` are the folders in use, relative to the story folder. */
export function workspaceBrief(names: StoryNames): string {
	const chapters = `${names.chapters}/`;
	const outlines = `${names.outlines}/`;
	const lore = names.lore.map((folder) => code(`${folder}/`));
	const zh = names.language === 'zh';
	const volume = zh ? '第一卷' : 'Volume 1';
	const chapter = zh ? '第3章' : 'Chapter 3';
	const sections = zh
		? [
				'你在帮一位作者写小说。你运行在 VS Code 扩展 Novel Helper 的侧边面板里，工作目录是这本书的故事目录，下面的路径都相对于它。',
				[
					'## 目录怎么摆',
					'',
					`- ${code(chapters)}：章节，一章一个 \`.md\` 或 \`.txt\` 文件。它下面的每一层文件夹是书的一层（卷、大章），层数不限，也可以不分卷直接放章。章节按路径排，数字按大小比：第2章 在 第10章 前面，第九章 在 第十二章 前面。`,
					`- ${code(outlines)}：大纲。大纲文件和它对应的东西同名，放在大纲目录里同样的位置：`,
					`  - 一章的大纲和章节文件同名：${code(`${chapters}${volume}/${chapter}.md`)} → ${code(`${outlines}${volume}/${chapter}.md`)}`,
					`  - 一层的大纲和那层的文件夹同名：${code(`${chapters}${volume}/`)} → ${code(`${outlines}${volume}.md`)}`,
					`  - 全书大纲是 ${code(`${outlines}${names.book}.md`)}`,
					`  - 大纲可以放得比正文浅（${code(`${outlines}${chapter}.md`)} 对 ${code(`${chapters}${volume}/${chapter}.md`)} 同样有效）；哪一层没有大纲文件，就是那一层没有大纲。`,
					`- ${code(`${names.summaries}/`)}：章节摘要，和章节同名，位置的规则和大纲一样。写后面的章节时，扩展用前面几章的摘要代替它们的正文，所以改了某一章的情节，它的摘要（如果有）要跟着改。`,
					`- ${lore.join('、')}：设定条目，一条一个文件，文件名就是条目名。`,
					'- `.novel-helper/`：扩展自己的文件（标记、模板、快照），不要动。',
				].join('\n'),
				[
					'## 设定条目的 frontmatter',
					'',
					'设定文件开头可以有 YAML frontmatter，每个字段都可以不写：',
					'',
					'- `name`：条目名；不写就用文件名',
					'- `aliases`：别名的列表；正文里出现别名也算提到这一条',
					'- `type`：类型，随便写（人物、地点、文风……），边栏按它分组',
					'- `always: true`：常驻，每次续写都带上，用在文风要求、世界观总则上',
					'- `summary`：摘要；有它时续写只发摘要，不发下面的正文',
					'',
					'改 frontmatter 时只动要改的字段，其余字段、顺序和注释保持原样。章节、大纲、摘要文件没有 frontmatter。',
				].join('\n'),
				// The outline markers (where on the outline a chapter is) get their section here once that feature is merged.
				[
					'## 你可以改什么',
					'',
					'- 故事目录里的文件都可以读、搜、改，包括正文，不用逐个问。每一轮开始前，扩展会给整个故事目录存一份快照；作者能看到这一轮改了哪些文件、和之前差在哪，也能一键退回。',
					'- 改动的范围跟着作者的话走：让改一段就改一段，没让动的章节不要顺手改。改完说清楚改了哪些文件、各改了什么。',
					'- 新建章节、大纲、摘要、设定条目时按上面的规则放，文件名照已有文件的写法起。',
					'- 运行命令、联网、读写故事目录以外的路径，都会先在面板里问作者，默认不放行。写小说用不上这些，能不用就不用。',
					'- 作者没有要求时，不要把设定里没有的关键设定（世界规则、人物的背景和关系）编进正文；需要的话先问作者，或者建议写进设定。',
				].join('\n'),
				[
					'## 每条消息附带的编辑器信息',
					'',
					'作者的每条消息前面有一个 `<editor-context>` 块，是扩展自动加的，不是作者写的：作者当前打开的文件、光标的位置、选中的文字。作者说「这一章」「这段」「这里」时，指的就是它。文件在发消息前已经保存，磁盘上的内容就是作者看到的内容。',
				].join('\n'),
			]
		: [
				'You are helping a writer with a novel. You run in the side panel of the VS Code extension Novel Helper; your working directory is the story folder of this book, and the paths below are relative to it.',
				[
					'## How the folder is laid out',
					'',
					`- ${code(chapters)}: the chapters, one \`.md\` or \`.txt\` file each. Every level of folders below it is a level of the book (a volume, an arc), any number of levels deep; chapters can also sit right in it. Chapters are in path order, numbers compared by value: Chapter 2 comes before Chapter 10.`,
					`- ${code(outlines)}: the outlines. An outline is named like what it is the outline of, at the same place in the outlines folder:`,
					`  - a chapter's outline is named like the chapter file: ${code(`${chapters}${volume}/${chapter}.md`)} → ${code(`${outlines}${volume}/${chapter}.md`)}`,
					`  - a level's outline is named like its folder: ${code(`${chapters}${volume}/`)} → ${code(`${outlines}${volume}.md`)}`,
					`  - the outline of the whole book is ${code(`${outlines}${names.book}.md`)}`,
					`  - an outline may sit higher than its chapter (${code(`${outlines}${chapter}.md`)} works for ${code(`${chapters}${volume}/${chapter}.md`)} too); a level without an outline file has no outline.`,
					`- ${code(`${names.summaries}/`)}: chapter summaries, named like the chapters, placed by the same rules as outlines. When a later chapter is written, the extension sends the summaries of the chapters before it in place of their text, so after changing what happens in a chapter, update its summary if it has one.`,
					`- ${lore.join(', ')}: lore entries, one file each; the file name is the entry's name.`,
					'- `.novel-helper/`: the extension\'s own files (marker, templates, snapshots). Leave it alone.',
				].join('\n'),
				[
					'## Frontmatter of lore entries',
					'',
					'A lore file may start with YAML frontmatter; every field is optional:',
					'',
					'- `name`: the entry\'s name; the file name if left out',
					'- `aliases`: a list of other names; one of them in the text counts as a mention of the entry',
					'- `type`: anything (character, place, style…); the sidebar groups entries by it',
					'- `always: true`: sent with every continuation request; for style rules and the basics of the world',
					'- `summary`: when present, continuation requests carry it in place of the text below',
					'',
					'When changing frontmatter, touch only the field in question and keep the other fields, their order and the comments. Chapters, outlines and summaries have no frontmatter.',
				].join('\n'),
				// The outline markers (where on the outline a chapter is) get their section here once that feature is merged.
				[
					'## What you may change',
					'',
					'- Read, search and change any file in the story folder, chapters included, without asking for each one. Before every turn the extension takes a snapshot of the whole story folder; the writer sees which files a turn changed and how, and can go back with one click.',
					'- Change as much as the writer asked for: one paragraph when asked for one paragraph, and no chapters nobody mentioned. Afterwards, say which files you changed and what you changed in each.',
					'- Put new chapters, outlines, summaries and lore entries where the rules above say, named the way the files already there are named.',
					'- Running commands, using the network, and reading or writing outside the story folder are asked about in the panel first and are not allowed by default. Writing a novel does not need them: do without where you can.',
					'- Unless the writer asks, do not write key facts that are not in the lore (rules of the world, a character\'s past and relations) into chapters; ask the writer first, or propose adding them to the lore.',
				].join('\n'),
				[
					'## What comes with every message',
					'',
					'Every message of the writer starts with an `<editor-context>` block that the extension adds, not the writer: the file they have open, where the cursor is, and what is selected. "This chapter", "this paragraph", "here" mean that. Files are saved before a message is sent, so what is on disk is what the writer sees.',
				].join('\n'),
			];
	return `${sections.join('\n\n')}\n`;
}

/** A selection longer than this is cut: the agent has its place in the file and can read the rest. */
export const MAX_SELECTION_CHARS = 8000;

/** What the writer has open when they send a message. Lines and columns count from 1. */
export interface EditorContext {
	/** The file, relative to the story folder. */
	path: string;
	/** The line the cursor is on. */
	line: number;
	selection?: { text: string; startLine: number; startColumn: number; endLine: number; endColumn: number };
	/** What happened to the files since the last message that the agent cannot know of. */
	notes?: string[];
}

/** The block put in front of a message; undefined when there is nothing to say. */
export function editorContextBlock(context: Partial<EditorContext>, language: NamesLanguage): string | undefined {
	const zh = language === 'zh';
	const lines: string[] = [];
	if (context.path !== undefined) {
		lines.push(zh ? `当前打开的文件：${context.path}` : `Open file: ${context.path}`);
		const selection = context.selection;
		if (selection) {
			const chars = [...selection.text];
			const cut = chars.length > MAX_SELECTION_CHARS;
			lines.push(
				zh
					? `选中了第 ${selection.startLine} 行第 ${selection.startColumn} 列到第 ${selection.endLine} 行第 ${selection.endColumn} 列，共 ${chars.length} 字${cut ? `；太长，下面只有开头的 ${MAX_SELECTION_CHARS} 字，其余按位置读文件` : ''}：`
					: `Selected: line ${selection.startLine}, column ${selection.startColumn} to line ${selection.endLine}, column ${selection.endColumn}, ${chars.length} characters${cut ? `; too long, so only the first ${MAX_SELECTION_CHARS} are below, read the file for the rest` : ''}:`,
				'<selection>',
				cut ? chars.slice(0, MAX_SELECTION_CHARS).join('') : selection.text,
				'</selection>',
			);
		} else if (context.line !== undefined) {
			lines.push(zh ? `光标在第 ${context.line} 行，没有选中文字。` : `The cursor is on line ${context.line}; nothing is selected.`);
		}
	}
	lines.push(...(context.notes ?? []));
	return lines.length ? `<editor-context>\n${lines.join('\n')}\n</editor-context>` : undefined;
}

/** How the context is named on the panel, above the input box: the file's name and how much is selected. */
export function editorContextLabel(context: Partial<EditorContext>): { file: string; selected: number } | undefined {
	return context.path === undefined ? undefined : { file: context.path.slice(context.path.lastIndexOf('/') + 1), selected: [...(context.selection?.text ?? '')].length };
}

/** What the agent is told, with the next message, after the writer went back to an earlier snapshot: what it read before may no longer be what is on disk. */
export function revertNote(paths: readonly string[], language: NamesLanguage): string {
	return language === 'zh'
		? `作者刚把故事目录退回到了更早的样子，这些文件变了：${paths.join('、')}。你之前读到的内容可能已经不是磁盘上的内容，用到时重新读。`
		: `The writer just took the story folder back to an earlier state. These files changed: ${paths.join(', ')}. What you read of them before may no longer be what is on disk: read again before relying on it.`;
}
