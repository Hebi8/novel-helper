// Turns raw model output into the one-sentence ghost text. Called on every
// streamed chunk; returns `pending` until the first sentence is complete, so
// the caller can stop the request as soon as it has what it will show.

import { CURSOR } from './context';
import { headChars } from './text';

export type SuggestionStatus = 'pending' | 'ok' | 'empty' | 'meta';

export interface Suggestion {
	status: SuggestionStatus;
	text: string;
}

export interface SuggestionOptions {
	/** Document text before the cursor. */
	before: string;
	/** Document text after the cursor. */
	after: string;
	maxChars: number;
	/** True once the stream has ended: no more text will arrive. */
	final: boolean;
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

function inDialogue(before: string): boolean {
	const line = before.slice(before.lastIndexOf('\n') + 1);
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

const NO_END = -1;
const WAIT = -2;

/** Index right after the first complete sentence, NO_END if there is none, WAIT if closers may still follow. */
function sentenceEnd(text: string, final: boolean): number {
	let content = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\n') {
			return content ? i : NO_END;
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
			return j === text.length && !final ? WAIT : j;
		}
		if (isContent(c)) {
			content = true;
		}
	}
	return NO_END;
}

/** Drops the end of `sentence` that already follows the cursor: 「你好|。」」 plus 「你好。」」 becomes 「你好」. */
function dropRepeatedEnding(sentence: string, after: string): string {
	let n = 0;
	while (n < after.length && ENDING.includes(after[n])) {
		n++;
	}
	for (let k = n; k > 0; k--) {
		if (sentence.endsWith(after.slice(0, k))) {
			return sentence.slice(0, -k);
		}
	}
	return sentence;
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
	const { before, after, maxChars, final } = options;
	const atLineStart = before === '' || before.endsWith('\n');
	// At a line start keep a full-width indent (　　) the model may have written.
	const trimStart = (s: string) => (atLineStart ? s.replace(/^[\n\r\t ]+/, '') : s.replace(/^\s+/, ''));

	let text = raw.replaceAll(CURSOR, '').replace(/\r/g, '');
	let spaced = /^[ \t]/.test(text);
	text = trimStart(text);
	const echo = echoLength(before, text);
	if (text && echo === text.length && !final) {
		return PENDING;
	}
	if (echo >= 2 || (echo === 1 && !isContent(text[0]))) {
		spaced = /^[ \t]/.test(text.slice(echo));
		text = trimStart(text.slice(echo));
	}
	if (!text) {
		return final ? { status: 'empty', text: '' } : PENDING;
	}

	const patterns = inDialogue(before) ? META_ALWAYS : [...META_ALWAYS, ...META_NARRATION];
	if (patterns.some((p) => p.test(text))) {
		return { status: 'meta', text: '' };
	}
	if (!final && text.length < MIN_JUDGED_CHARS) {
		return PENDING;
	}

	const end = sentenceEnd(text, final);
	if (end === WAIT) {
		return PENDING;
	}
	let sentence: string;
	if (end === NO_END) {
		if (text.length < maxChars && !final) {
			return PENDING;
		}
		sentence = text.length > maxChars ? clip(text, maxChars) : text;
	} else {
		sentence = end > maxChars ? clip(text.slice(0, end), maxChars) : text.slice(0, end);
	}

	sentence = dropRepeatedEnding(sentence, after).trimEnd();
	if (!sentence) {
		return { status: 'empty', text: '' };
	}
	return { status: 'ok', text: spaced && keepsSpace(before, sentence) ? ` ${sentence}` : sentence };
}
