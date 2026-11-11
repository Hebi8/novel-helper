// Builds the prompt for one continuation request and records what went into
// it. Order follows how often each part changes, so providers that cache
// prompt prefixes can reuse the start of the prompt between requests:
//   system:  instructions, always-on entries          (same for every request)
//   stable:  previous chapters, this chapter's outline (same within a chapter)
//   dynamic: matched entries, text around the cursor   (changes every request)
// The text right before the cursor comes last, so the model reads prose last.

import type { LoreEntry } from './library';
import { type Hit, type Matcher, rankHits } from './match';
import { frontmatterLength, headChars, splitFrontmatter, stem, tailChars } from './text';

export const CURSOR = '⟨光标⟩';

export const INSTRUCTIONS = `你是小说写作助手，负责行内续写：从正文里 ${CURSOR} 所在的位置接着往下写。

要求：
1. 只输出要插在光标处的文字，从光标处直接接上，不要重复光标前已有的字。
2. 只写一句：写到第一个句号、问号、感叹号或省略号就停；不换行，不分段。
3. 不解释，不打招呼，不加标题、引号包裹或任何标记，也不要输出 ${CURSOR}。
4. 用和正文相同的语言，保持原文的人称、时态、文风和标点习惯。
5. 人物的言行、称呼和关系要和资料一致；资料里没有的关键设定不要自己编。
6. 光标后面如果已经有文字，续写要能自然接上它。`;

export interface ContextLimits {
	/** Text before the cursor sent to the model. */
	beforeChars: number;
	/** Text after the cursor sent to the model. */
	afterChars: number;
	/** Text before the cursor searched for lore names. */
	scanChars: number;
	/** Budget for always-on entries. */
	alwaysChars: number;
	/** Budget for entries matched by name. */
	matchedChars: number;
	/** Cap for a single entry (its summary, or the start of its body). */
	entryChars: number;
	outlineChars: number;
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

export interface ContextInput {
	/** Relative path (or name) of the document being written. */
	documentPath: string;
	/** Document text before the cursor. */
	before: string;
	/** Document text after the cursor. */
	after: string;
	entries: readonly LoreEntry[];
	matcher: Matcher;
	outline?: { path: string; content: string };
	/** Previous chapters, oldest first. */
	previous: ChapterSource[];
	limits: ContextLimits;
}

export interface Prompt {
	system: string;
	stable: string;
	dynamic: string;
}

export interface UsedEntry {
	id: string;
	name: string;
	type?: string;
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
	matched: UsedEntry[];
	/** Entries left out because their budget ran out. */
	skipped: SkippedEntry[];
	limits: ContextLimits;
	outline?: { path: string; chars: number; truncated: boolean };
	previous: Array<{ path: string; source: 'summary' | 'ending'; chars: number; truncated: boolean }>;
	before: { chars: number; truncated: boolean };
	after: { chars: number; truncated: boolean };
	scannedChars: number;
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

function entryPiece(entry: LoreEntry, max: number): Piece {
	const source = entry.summary ? 'summary' : 'body';
	const cut = headChars(entry.summary ?? entry.body, max);
	const text = cut.truncated ? `${cut.text}（后略）` : cut.text;
	return {
		block: text ? `${entryHeader(entry)}\n${text}` : entryHeader(entry),
		chars: cut.text.length,
		truncated: cut.truncated,
		source,
	};
}

function tagged(tag: string, body: string, attrs = ''): string {
	return `<${tag}${attrs}>\n${body}\n</${tag}>`;
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

	const before = input.before.slice(frontmatterLength(input.before));
	const scan = tailChars(before, limits.scanChars).text;
	const outlineText = input.outline ? splitFrontmatter(input.outline.content).body.trim() : '';
	const hits = rankHits(input.matcher.find(scan), scan.length, outlineText ? input.matcher.find(outlineText) : []);
	const byId = new Map(input.entries.map((e) => [e.id, e]));

	const matched: UsedEntry[] = [];
	const matchedBlocks: string[] = [];
	room = limits.matchedChars;
	for (const hit of hits) {
		const entry = byId.get(hit.id);
		if (!entry || entry.always) {
			continue;
		}
		const piece = entryPiece(entry, limits.entryChars);
		if (piece.chars > room) {
			skipped.push({ id: entry.id, name: entry.name, type: entry.type, chars: piece.chars, always: false, hit });
			continue;
		}
		room -= piece.chars;
		matchedBlocks.push(piece.block);
		matched.push({ id: entry.id, name: entry.name, type: entry.type, chars: piece.chars, truncated: piece.truncated, source: piece.source, hit });
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
	let outlineBlock = '';
	if (input.outline && outlineText) {
		const cut = headChars(outlineText, limits.outlineChars);
		outlineBlock = tagged('本章大纲', `${cut.text}${cut.truncated ? '（后略）' : ''}`);
		outline = { path: input.outline.path, chars: cut.text.length, truncated: cut.truncated };
	}

	const beforeCut = tailChars(before, limits.beforeChars, true);
	const afterCut = headChars(input.after, limits.afterChars);
	const afterText = afterCut.text.trimEnd();
	const chapterText =
		(beforeCut.truncated ? '（前略）' : '') +
		beforeCut.text +
		CURSOR +
		afterText +
		(afterCut.truncated && afterText ? '（后略）' : '');

	const system = alwaysBlocks.length
		? `${INSTRUCTIONS}\n\n${tagged('常驻资料', alwaysBlocks.join('\n\n'))}`
		: INSTRUCTIONS;
	const stable = [previousBlocks.length ? tagged('前文', previousBlocks.join('\n\n')) : '', outlineBlock]
		.filter(Boolean)
		.join('\n\n');
	const dynamic = [
		matchedBlocks.length ? tagged('本章涉及的资料', matchedBlocks.join('\n\n')) : '',
		tagged('当前章节', chapterText, ` 文件="${stem(input.documentPath)}"`),
		`从 ${CURSOR} 处接着写一句。`,
	]
		.filter(Boolean)
		.join('\n\n');

	return {
		prompt: { system, stable, dynamic },
		trace: {
			always,
			matched,
			skipped,
			limits,
			outline,
			previous,
			before: { chars: beforeCut.text.length, truncated: beforeCut.truncated },
			after: { chars: afterText.length, truncated: afterCut.truncated },
			scannedChars: scan.length,
		},
	};
}
