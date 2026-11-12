// Builds the prompt for one continuation request and records what went into
// it. Providers bill a prompt prefix they have seen before at about a tenth of
// the price, so the prompt is laid out to keep one request a prefix of the
// next for as long as possible:
//   system:   instructions, always-on entries              (same for every request)
//   outlines: the book, the levels above the chapter,
//             previous chapters, this chapter's outline;
//             or, for a chapter with a place on the
//             outline graph, the book, what is above that
//             place, the node it is in, the node after it  (same until the place moves)
//   lore:     entries named in the chapter, in the order
//             they first come up                           (grows now and then)
//   text:     this chapter from its start to the cursor,
//             cut into pieces at line ends                 (only ever appended to)
//   tail:     the line being written, the cursor, the
//             text after it, how much to write             (changes every request)
// Cache breakpoints go after the outlines and after the last two finished
// pieces before the tail: a request reads everything up to the previous
// breakpoint from the cache and adds one piece to it.

import { type BuoyKind, positionLine } from './buoy';
import type { LoreEntry } from './library';
import { type Hit, type Matcher, rankHits } from './match';
import { chunkEnds, frontmatterLength, headChars, splitFrontmatter, stem, steppedStart, tailChars } from './text';

export const CURSOR = '⟨光标⟩';

// The same text for every request: what changes (how long the continuation may be) is said at the end of the user message.
export const INSTRUCTIONS = `你是小说写作助手，负责行内续写：从正文里 ${CURSOR} 所在的位置接着往下写。作者会一次次收下你写的内容再让你接着写，所以每一次续写都要让故事往前走一步。

要求：
1. 只输出要插在光标处的文字，从光标处直接接上，不要重复光标前已有的字。
2. 长度不超过最后给出的字数上限（标点算在内；正文是英文时按字符算）。不必写满：在句末的自然停顿处结束，只写一两句也可以，不要停在半句话上。
3. 可以分段，分段的写法跟随正文已有的习惯：段与段之间是空一行还是只换行、段首有没有全角空格缩进，都和前文保持一致。光标前的那一段已经写完、接下来该另起一段时，先换行再写。
4. 不解释，不打招呼，不加标题、引号包裹或任何标记，也不要输出 ${CURSOR}。
5. 用和正文相同的语言，保持原文的人称、时态、文风和标点习惯。
6. 推进情节，不要原地打转：
   - 有 <当前位置> 时，它说的是正文现在写到了大纲的哪个节点，后面跟着这个节点的内容和接下来的节点。先对照正文判断当前节点里哪些内容已经写到，续写朝还没写到的内容走；当前节点写完了，就朝接下来的节点过渡。位置是「从一个节点衔接到另一个节点」时，写两者之间的过渡，朝后一个节点的开头走；位置是「同时在写两个节点」时，两条线都要照顾到。已经写过的内容不要重写，也不要越过接下来的节点往更后面跳，中间该有的过程照常写。没有给出接下来的节点时，把当前节点写完就顺势收束，不要另起大纲里没有的大事件。
   - 没有 <当前位置>、有 <本章大纲> 时，先对照正文判断大纲里哪些内容已经写到，续写朝下一个还没写到的点走。已经写过的点不要重写，也不要一步跳到很后面的点，中间该有的过程照常写。大纲里的内容都写完了，就顺着写本章的收尾，不要另起大纲里没有的大事件。
   - 两者都没有时，每次续写都要带来新东西：新的动作、对话、信息或局面变化。
   - 上文已经表达过的动作、情绪和描写，不要换个说法再写一遍。
7. 人物的言行、称呼和关系不能和资料冲突，也不要编造资料里没有的关键设定（世界规则、人物背景和关系）。情节往前发展，以及场景里的小细节（动作、神态、环境、对话的具体内容），可以自己写。
8. 光标后面如果已经有文字，续写要能自然接上它。`;

/** Size of the pieces the chapter text is cut into for caching. */
export const TEXT_CHUNK_CHARS = 300;

export interface ContextLimits {
	/** Most text of this document before the cursor sent to the model; lore names are searched in the same text. */
	beforeChars: number;
	/** Text after the cursor sent to the model. */
	afterChars: number;
	/** Budget for always-on entries. */
	alwaysChars: number;
	/** Budget for entries matched by name. */
	matchedChars: number;
	/** Cap for a single entry (its summary, or the start of its body). */
	entryChars: number;
	/** Cap for the whole book's outline. */
	bookOutlineChars: number;
	/** Cap for the outline of each level between the book and the chapter (卷, 幕…). */
	levelOutlineChars: number;
	/** Cap for this chapter's outline, and for each node the chapter is in on the outline graph. */
	outlineChars: number;
	/** Cap for the node that comes after those. */
	nextNodeChars: number;
	/** Cap per previous chapter (its summary, or the end of its text). */
	previousChapterChars: number;
}

export interface ChapterSource {
	path: string;
	/** Content of the chapter's summary file, if it has one. */
	summary?: string;
	/** Content of the chapter itself, used when there is no summary. */
	text?: string;
}

/** The whole book, or a folder level above the chapter, with its outline if it has one. */
export interface LevelSource {
	name: string;
	book: boolean;
	outline?: { path: string; content: string };
}

/** A node of the outline graph as it goes into the prompt. */
export interface NodeSource {
	title: string;
	/** The file it is written in, if any. */
	path?: string;
	/** What is written right under it. */
	text: string;
}

/** Where the chapter is on the outline graph. */
export interface PositionSource {
	kind: BuoyKind;
	/** The node the text is in; for a bridge, where it comes from and where it goes; for parallel, both. */
	nodes: NodeSource[];
	/** The nodes the first of those is under, outermost first, the book aside. */
	above: NodeSource[];
	/** The node after them on the main line. */
	next?: NodeSource;
}

export interface ContextInput {
	/** Relative path (or name) of the document being written. */
	documentPath: string;
	/** Document text before the cursor. */
	before: string;
	/** Document text after the cursor. */
	after: string;
	/** Longest continuation to ask for, in characters. */
	maxChars: number;
	entries: readonly LoreEntry[];
	matcher: Matcher;
	/** The book first, then each level down to the chapter's folder. */
	levels: LevelSource[];
	/** This chapter's outline; not used when `position` is given. */
	outline?: { path: string; content: string };
	/** Where the chapter is on the outline graph. With it, `levels` is the book alone: `position.above` stands for the rest. */
	position?: PositionSource;
	/** Previous chapters, oldest first. */
	previous: ChapterSource[];
	limits: ContextLimits;
}

export interface PromptBlock {
	text: string;
	/** A cache breakpoint goes right after this block. */
	cache: boolean;
}

export interface Prompt {
	system: string;
	/** The user message; the blocks joined as they are make its text. */
	user: PromptBlock[];
}

export interface UsedEntry {
	id: string;
	name: string;
	type?: string;
	/** Characters the entry takes in the prompt, its name line included. */
	chars: number;
	truncated: boolean;
	source: 'summary' | 'body';
	/** Why a matched entry was picked; undefined for always-on entries. */
	hit?: Hit;
}

export interface SkippedEntry {
	id: string;
	name: string;
	type?: string;
	chars: number;
	always: boolean;
	hit?: Hit;
}

export interface ContextTrace {
	always: UsedEntry[];
	/** In the order they appear in the prompt. */
	matched: UsedEntry[];
	/** Entries left out because their budget ran out. */
	skipped: SkippedEntry[];
	limits: ContextLimits;
	/** One per level, the book first; `path` is undefined when the level has no outline. */
	levels: Array<{ name: string; book: boolean; path?: string; chars: number; truncated: boolean }>;
	outline?: { path: string; chars: number; truncated: boolean };
	position?: { kind: BuoyKind; nodes: NodeTrace[]; next?: NodeTrace };
	previous: Array<{ path: string; source: 'summary' | 'ending'; chars: number; truncated: boolean }>;
	before: { chars: number; truncated: boolean };
	after: { chars: number; truncated: boolean };
}

export interface NodeTrace {
	title: string;
	path?: string;
	chars: number;
	truncated: boolean;
}

interface Piece {
	block: string;
	chars: number;
	truncated: boolean;
	source: 'summary' | 'body';
}

function entryHeader(entry: LoreEntry): string {
	const meta = [entry.type, entry.aliases.length ? `别名：${entry.aliases.join('、')}` : undefined]
		.filter(Boolean)
		.join('；');
	return meta ? `【${entry.name}】（${meta}）` : `【${entry.name}】`;
}

/** `max` caps the summary or body; the budget is charged for the whole block, name line included. */
function entryPiece(entry: LoreEntry, max: number): Piece {
	const source = entry.summary ? 'summary' : 'body';
	const cut = headChars(entry.summary ?? entry.body, max);
	const text = cut.truncated ? `${cut.text}（后略）` : cut.text;
	const block = text ? `${entryHeader(entry)}\n${text}` : entryHeader(entry);
	return { block, chars: block.length, truncated: cut.truncated, source };
}

function tagged(tag: string, body: string): string {
	return `<${tag}>\n${body}\n</${tag}>`;
}

/** The user message as one string. */
export function userText(prompt: Prompt): string {
	return prompt.user.map((block) => block.text).join('');
}

export function buildContext(input: ContextInput): { prompt: Prompt; trace: ContextTrace } {
	const { limits } = input;
	const skipped: SkippedEntry[] = [];

	const always: UsedEntry[] = [];
	const alwaysBlocks: string[] = [];
	let room = limits.alwaysChars;
	for (const entry of input.entries) {
		if (!entry.always) {
			continue;
		}
		const piece = entryPiece(entry, limits.entryChars);
		if (piece.chars > room) {
			skipped.push({ id: entry.id, name: entry.name, type: entry.type, chars: piece.chars, always: true });
			continue;
		}
		room -= piece.chars;
		alwaysBlocks.push(piece.block);
		always.push({ id: entry.id, name: entry.name, type: entry.type, chars: piece.chars, truncated: piece.truncated, source: piece.source });
	}

	// The chapter from its start. When it outgrows the limit the start moves a third of the limit at a time.
	const body = input.before.slice(frontmatterLength(input.before));
	const start = steppedStart(body, limits.beforeChars, Math.max(1, Math.ceil(limits.beforeChars / 3)));
	const before = body.slice(start);

	const { position } = input;
	// Names are looked for in the outline of what is being written: the nodes the chapter is in, or the chapter's own outline.
	const outlineText = position
		? position.nodes.map((node) => `${node.title}\n${node.text}`).join('\n')
		: input.outline
			? splitFrontmatter(input.outline.content).body.trim()
			: '';
	const hits = rankHits(input.matcher.find(before), before.length, outlineText ? input.matcher.find(outlineText) : []);
	const order = new Map(input.entries.map((entry, index) => [entry.id, index]));

	// Entries are picked best first, then laid out so that a new one lands at the end:
	// those named in the outline in path order, the rest in the order they first come up in the text.
	const picked: Array<{ entry: LoreEntry; piece: Piece; hit: Hit }> = [];
	room = limits.matchedChars;
	for (const hit of hits) {
		const entry = input.entries[order.get(hit.id) ?? -1];
		if (!entry || entry.always) {
			continue;
		}
		const piece = entryPiece(entry, limits.entryChars);
		if (piece.chars > room) {
			skipped.push({ id: entry.id, name: entry.name, type: entry.type, chars: piece.chars, always: false, hit });
			continue;
		}
		room -= piece.chars;
		picked.push({ entry, piece, hit });
	}
	const placeOf = (hit: Hit) => (hit.inOutline ? -1 : hit.first ?? 0);
	picked.sort((a, b) => placeOf(a.hit) - placeOf(b.hit) || order.get(a.entry.id)! - order.get(b.entry.id)!);
	const matched = picked.map(({ entry, piece, hit }): UsedEntry => ({
		id: entry.id, name: entry.name, type: entry.type, chars: piece.chars, truncated: piece.truncated, source: piece.source, hit,
	}));

	const levels: ContextTrace['levels'] = [];
	const levelBlocks: string[] = [];
	for (const level of input.levels) {
		const text = level.outline ? splitFrontmatter(level.outline.content).body.trim() : '';
		const cut = headChars(text, level.book ? limits.bookOutlineChars : limits.levelOutlineChars);
		if (cut.text) {
			levelBlocks.push(`【${level.name}】\n${cut.text}${cut.truncated ? '（后略）' : ''}`);
		}
		levels.push({ name: level.name, book: level.book, path: level.outline?.path, chars: cut.text.length, truncated: cut.truncated });
	}
	for (const node of position?.above ?? []) {
		const cut = headChars(node.text, limits.levelOutlineChars);
		if (cut.text) {
			levelBlocks.push(`【${node.title}】\n${cut.text}${cut.truncated ? '（后略）' : ''}`);
		}
		levels.push({ name: node.title, book: false, path: node.path, chars: cut.text.length, truncated: cut.truncated });
	}

	const previous: ContextTrace['previous'] = [];
	const previousBlocks: string[] = [];
	for (const chapter of input.previous) {
		const title = stem(chapter.path);
		if (chapter.summary !== undefined) {
			const cut = headChars(splitFrontmatter(chapter.summary).body.trim(), limits.previousChapterChars);
			previousBlocks.push(`【${title}】摘要：\n${cut.text}${cut.truncated ? '（后略）' : ''}`);
			previous.push({ path: chapter.path, source: 'summary', chars: cut.text.length, truncated: cut.truncated });
		} else if (chapter.text !== undefined) {
			const cut = tailChars(splitFrontmatter(chapter.text).body.trim(), limits.previousChapterChars, true);
			previousBlocks.push(`【${title}】结尾：\n${cut.truncated ? '（前略）' : ''}${cut.text}`);
			previous.push({ path: chapter.path, source: 'ending', chars: cut.text.length, truncated: cut.truncated });
		}
	}

	let outline: ContextTrace['outline'];
	let positionTrace: ContextTrace['position'];
	let outlineBlock = '';
	if (position) {
		const piece = (node: NodeSource, max: number): { block: string; trace: NodeTrace } => {
			const cut = headChars(node.text, max);
			return {
				block: `【${node.title}】${cut.text ? `\n${cut.text}${cut.truncated ? '（后略）' : ''}` : ''}`,
				trace: { title: node.title, path: node.path, chars: cut.text.length, truncated: cut.truncated },
			};
		};
		const nodes = position.nodes.map((node) => piece(node, limits.outlineChars));
		const next = position.next && piece(position.next, limits.nextNodeChars);
		outlineBlock = tagged(
			'当前位置',
			[positionLine(position.kind, position.nodes.map((node) => node.title)), ...nodes.map((node) => node.block), ...(next ? [`接下来是：\n${next.block}`] : [])].join('\n\n'),
		);
		positionTrace = { kind: position.kind, nodes: nodes.map((node) => node.trace), next: next?.trace };
	} else if (input.outline && outlineText) {
		const cut = headChars(outlineText, limits.outlineChars);
		outlineBlock = tagged('本章大纲', `${cut.text}${cut.truncated ? '（后略）' : ''}`);
		outline = { path: input.outline.path, chars: cut.text.length, truncated: cut.truncated };
	}

	const outlines = [
		levelBlocks.length ? tagged('上层大纲', levelBlocks.join('\n\n')) : '',
		previousBlocks.length ? tagged('前文', previousBlocks.join('\n\n')) : '',
		outlineBlock,
	].filter(Boolean);

	// Lore and the finished pieces of the chapter: the part that is only ever added to.
	const grown: string[] = [];
	if (picked.length) {
		grown.push(`${tagged('本章涉及的资料', picked.map((p) => p.piece.block).join('\n\n'))}\n\n`);
	}
	let opened = `<当前章节 文件="${stem(input.documentPath)}">\n${start > 0 ? '（前略）' : ''}`;
	let from = 0;
	for (const end of chunkEnds(before, TEXT_CHUNK_CHARS)) {
		grown.push(opened + before.slice(from, end));
		opened = '';
		from = end;
	}

	const afterCut = headChars(input.after, limits.afterChars);
	const afterText = afterCut.text.trimEnd();
	const tail =
		opened +
		before.slice(from) +
		CURSOR +
		afterText +
		(afterCut.truncated && afterText ? '（后略）' : '') +
		`\n</当前章节>\n\n从 ${CURSOR} 处接着往下写，最多 ${input.maxChars} 个字。`;

	const user: PromptBlock[] = [
		...(outlines.length ? [{ text: `${outlines.join('\n\n')}\n\n`, cache: true }] : []),
		...grown.map((text, index) => ({ text, cache: index >= grown.length - 2 })),
		{ text: tail, cache: false },
	];
	const system = alwaysBlocks.length
		? `${INSTRUCTIONS}\n\n${tagged('常驻资料', alwaysBlocks.join('\n\n'))}`
		: INSTRUCTIONS;

	return {
		prompt: { system, user },
		trace: {
			always,
			matched,
			skipped,
			limits,
			levels,
			outline,
			position: positionTrace,
			previous,
			before: { chars: before.length, truncated: start > 0 },
			after: { chars: afterText.length, truncated: afterCut.truncated },
		},
	};
}
