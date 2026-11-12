// Turns raw model output into the ghost text: at most `maxChars` characters,
// in one paragraph or several, ending where a sentence ends. Called on every
// streamed chunk; returns `pending` until it is known where the ghost text
// ends, so the caller can stop the request as soon as it has what it will show.
//
// The model is free to stop early, and then all it wrote is shown. Text that
// runs past the limit is cut after the last sentence end within it, or, with
// none there, at the limit. Paragraph breaks are rewritten the way the text
// before the cursor has them.

import { CURSOR } from './context';
import { frontmatterLength, headChars } from './text';

export type SuggestionStatus = 'pending' | 'ok' | 'empty' | 'meta';

export interface Suggestion {
	status: SuggestionStatus;
	text: string;
}

export interface SuggestionOptions {
	/** Document text before the cursor. */
	before: string;
	/** Document text after the cursor; only the rest of the cursor's line is looked at. */
	after: string;
	/** Longest ghost text, line breaks and indents included. */
	maxChars: number;
	/** True once the stream has ended: no more text will arrive. */
	final: boolean;
	/** With `final`: the stream ended because the model ran into its output cap, not where it chose to stop. */
	cutOff?: boolean;
}

const SENTENCE_END = '。！？!?…';
/** May follow a sentence end and still belong to the sentence: 。」 ！』 ……） */
const TRAILING = '。！？!?…」』”’）)】》〉"\'～~';
const CLOSERS = '」』”’）)】》〉"\'';
/** Ending punctuation that may already follow the cursor and must not be written twice. */
const ENDING = `${TRAILING}.`;
const SOFT_BREAK = '，、；：,;: —';
const OPENING_QUOTES = '「『“';
const CLOSING_QUOTES = '」』”';
/** Characters of scripts written without spaces between words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

/** How much of the text before the cursor is looked at: for what the model repeats of it and for how its paragraphs are written. */
const TAIL_CHARS = 2000;
const HEADING = /^#{1,6}\s/;

/** Output shorter than this is not judged yet: 「好的。」 might be the start of 「好的。以下是续写……」. */
const MIN_JUDGED_CHARS = 12;

/** Patterns that mark a reply as talking about the task instead of continuing the prose. */
const META_ALWAYS = [/^(续写|续文|正文|输出)(内容|结果)?[:：]/];
/** Checked only outside dialogue, where these openings would not be a character speaking. */
const META_NARRATION = [
	/^(好的|好|当然|没问题|明白了?|收到)[，,。！!]?\s*(以下|下面)(是|为)/,
	/^(以下|下面)(是|为)/,
	/^(根据|基于)(您|你)(的|提供)/,
	/^(抱歉|很抱歉|对不起)[，,]?我?(无法|不能)/,
	/^(sure|certainly|of course)[,!.]/i,
	/^here('s| is| are) /i,
	/^(i'm sorry|i am sorry|i can't|i cannot)\b/i,
];

const PENDING: Suggestion = { status: 'pending', text: '' };

function isContent(c: string): boolean {
	return /[\p{L}\p{N}]/u.test(c);
}

/** `line`: the cursor's line up to the cursor. */
function inDialogue(line: string): boolean {
	let depth = 0;
	for (const c of line) {
		if (OPENING_QUOTES.includes(c)) {
			depth++;
		} else if (CLOSING_QUOTES.includes(c)) {
			depth = Math.max(0, depth - 1);
		}
	}
	return depth > 0;
}

/** Length of the longest start of `text` that repeats the end of `before`. */
function echoLength(before: string, text: string): number {
	for (let k = Math.min(before.length, text.length, 200); k > 0; k--) {
		if (before.endsWith(text.slice(0, k))) {
			return k;
		}
	}
	return 0;
}

interface ParagraphStyle {
	/** What stands between two paragraphs; undefined when the text shows none. */
	separator?: '\n' | '\n\n';
	/** What a paragraph starts with (　　, or nothing); undefined when the text has no paragraph yet. */
	indent?: string;
}

/** How the paragraphs in `lines` are written: a blank line between them or just a line break, and their indent. */
function paragraphStyle(lines: string[]): ParagraphStyle {
	const indents = new Map<string, number>();
	let single = 0;
	let blank = 0;
	/** Empty lines since the last paragraph; undefined before the first one and after a heading. */
	let gap: number | undefined;
	for (const line of lines) {
		if (!line.trim()) {
			gap = gap === undefined ? undefined : gap + 1;
			continue;
		}
		if (HEADING.test(line)) {
			gap = undefined;
			continue;
		}
		if (gap !== undefined) {
			if (gap > 0) {
				blank++;
			} else {
				single++;
			}
		}
		gap = 0;
		const indent = /^[ \t\u3000]*/.exec(line)![0];
		indents.set(indent, (indents.get(indent) ?? 0) + 1);
	}
	let indent: string | undefined;
	for (const [candidate, count] of indents) {
		if (indent === undefined || count > indents.get(indent)!) {
			indent = candidate;
		}
	}
	return { separator: blank + single === 0 ? undefined : blank >= single ? '\n\n' : '\n', indent };
}

/** The indent at the end of the whitespace the model wrote before a paragraph; only a full-width one counts. */
function writtenIndent(written: string): string {
	return written.slice(written.lastIndexOf('\n') + 1).replace(/[ \t]/g, '');
}

/** A paragraph break as the model wrote it (`written`: line breaks with any whitespace around them), in the style of the text. */
function paragraphBreak(written: string, style: ParagraphStyle): string {
	const separator = style.separator ?? (written.indexOf('\n') === written.lastIndexOf('\n') ? '\n' : '\n\n');
	return separator + (style.indent ?? writtenIndent(written));
}

/** True when a new paragraph may follow `line`: it ends a sentence, it ends with a colon (speech on a line of its own), or it is a heading. */
function paragraphOver(line: string): boolean {
	const last = line.trimEnd().slice(-1);
	return (last !== '' && `${ENDING}：:`.includes(last)) || HEADING.test(line);
}

/**
 * Where `text` may end: right after each sentence end, with the closers that
 * follow it, and at the end of each paragraph. A sentence end that the text
 * so far stops at is left out until `final`: closers may still follow it.
 */
function stops(text: string, final: boolean): number[] {
	const found: number[] = [];
	let content = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\n') {
			if (content && text[i - 1] !== '\n' && found[found.length - 1] !== i) {
				found.push(i);
			}
			continue;
		}
		const next = text[i + 1];
		const ends =
			SENTENCE_END.includes(c) ||
			(c === '.' && (next === undefined ? final : /\s/.test(next) || CLOSERS.includes(next)));
		if (ends && content) {
			let j = i + 1;
			while (j < text.length && TRAILING.includes(text[j])) {
				j++;
			}
			if (j < text.length || final) {
				found.push(j);
			}
			i = j - 1;
		} else if (isContent(c)) {
			content = true;
		}
	}
	return found;
}

/** Drops the end of `text` that already follows the cursor: 「你好|。」」 plus 「你好。」」 becomes 「你好」. */
function dropRepeatedEnding(text: string, after: string): string {
	let n = 0;
	while (n < after.length && ENDING.includes(after[n])) {
		n++;
	}
	for (let k = n; k > 0; k--) {
		if (text.endsWith(after.slice(0, k))) {
			return text.slice(0, -k);
		}
	}
	return text;
}

/** True when the space the model wrote belongs between `before` and `text`: 「the door」 and 「and」, not 「推开门」 and 「走了」. */
function keepsSpace(before: string, text: string): boolean {
	const last = Array.from(before.slice(-2)).pop() ?? '';
	const first = Array.from(text.slice(0, 2))[0] ?? '';
	return last !== '' && !/\s/.test(last) && !UNSPACED.test(last) && !UNSPACED.test(first);
}

/** Cuts to `max` characters, preferring to end right after a comma-like break. */
function clip(text: string, max: number): string {
	const cut = headChars(text, max).text;
	for (let i = cut.length - 1; i >= max / 2; i--) {
		if (SOFT_BREAK.includes(cut[i])) {
			return cut.slice(0, i + 1);
		}
	}
	return cut;
}

export function extractSuggestion(raw: string, options: SuggestionOptions): Suggestion {
	const { maxChars, final } = options;
	const after = options.after.split('\n', 1)[0];
	const body = options.before.slice(frontmatterLength(options.before));
	const before = body.slice(-TAIL_CHARS).replace(/\r/g, '');
	const lines = before.split('\n');
	/** The cursor's line up to the cursor. */
	const line = lines[lines.length - 1];
	// Cut out of a longer text, the first line may not be a whole one.
	const style = paragraphStyle(body.length > TAIL_CHARS ? lines.slice(1) : lines);

	let text = raw.replaceAll(CURSOR, '').replace(/\r/g, '');
	let spaced = /^[ \t]/.test(text);
	/** The whitespace the model put in front of its text. */
	let lead = /^\s*/.exec(text)![0];
	text = text.slice(lead.length);
	const echo = echoLength(before, text);
	if (text && echo === text.length && !final) {
		return PENDING;
	}
	if (echo >= 2 || (echo === 1 && !isContent(text[0]))) {
		text = text.slice(echo);
		spaced = /^[ \t]/.test(text);
		lead = /^\s*/.exec(text)![0];
		text = text.slice(lead.length);
	}
	if (!text) {
		return final ? { status: 'empty', text: '' } : PENDING;
	}

	const patterns = inDialogue(line) ? META_ALWAYS : [...META_ALWAYS, ...META_NARRATION];
	if (patterns.some((p) => p.test(text))) {
		return { status: 'meta', text: '' };
	}
	if (!final && text.length < MIN_JUDGED_CHARS) {
		return PENDING;
	}

	/** What goes in front of the text: an indent at a line start, a paragraph break where the model started a new paragraph. */
	let opening = '';
	if (line === '') {
		opening = style.indent ?? writtenIndent(lead);
	} else if (lead.includes('\n') && paragraphOver(line) && !after.trim()) {
		opening = paragraphBreak(lead, style);
		spaced = false;
	}
	text = opening + text.replace(/[ \t\u3000]*\n\s*/g, (found) => paragraphBreak(found, style));

	const ends = stops(text, final);
	let shown: string | undefined;
	// The text reaches what already follows the cursor (」 after 「你好。」): it ends there.
	for (const end of ends) {
		const kept = dropRepeatedEnding(text.slice(0, end), after);
		if (kept.length < end) {
			shown = kept.length <= maxChars ? kept : undefined;
			break;
		}
	}
	if (shown === undefined) {
		const over = text.length > maxChars;
		if (!over && !final) {
			return PENDING;
		}
		if (over || options.cutOff) {
			const end = ends.filter((at) => at <= maxChars).pop();
			shown = end !== undefined ? text.slice(0, end) : over ? clip(text, maxChars) : text;
		} else {
			shown = text;
		}
		shown = dropRepeatedEnding(shown, after);
	}

	shown = shown.trimEnd();
	if (!shown) {
		return { status: 'empty', text: '' };
	}
	return { status: 'ok', text: spaced && keepsSpace(before, shown) ? ` ${shown}` : shown };
}
