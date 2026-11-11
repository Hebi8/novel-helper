// Small string helpers. Lengths are UTF-16 code units (one per CJK character);
// cuts never split a surrogate pair.

export interface Cut {
	text: string;
	truncated: boolean;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** First `max` characters. */
export function headChars(text: string, max: number): Cut {
	if (text.length <= max) {
		return { text, truncated: false };
	}
	let end = Math.max(0, max);
	if (end > 0 && isLowSurrogate(text.charCodeAt(end))) {
		end--;
	}
	return { text: text.slice(0, end), truncated: true };
}

/**
 * Last `max` characters. With `snapToLine`, a cut that lands mid-line moves
 * forward to the next line start when that costs less than a third of the text.
 */
export function tailChars(text: string, max: number, snapToLine = false): Cut {
	if (text.length <= max) {
		return { text, truncated: false };
	}
	let start = text.length - Math.max(0, max);
	if (isLowSurrogate(text.charCodeAt(start))) {
		start++;
	}
	if (snapToLine && start > 0 && text[start - 1] !== '\n') {
		const newline = text.indexOf('\n', start);
		if (newline !== -1 && newline - start < max / 3) {
			start = newline + 1;
		}
	}
	return { text: text.slice(start), truncated: true };
}

/**
 * Where to start so that at most `max` characters of `text` are left, moving
 * forward a whole `step` at a time: while the text grows by less than a step
 * the start stays where it is, so what is left keeps the same beginning (and
 * a prompt cache keyed on it keeps hitting). A start that lands mid-line
 * moves on to the next line when that is close.
 */
export function steppedStart(text: string, max: number, step: number): number {
	if (text.length <= max) {
		return 0;
	}
	let start = Math.min(text.length, Math.ceil((text.length - max) / step) * step);
	if (isLowSurrogate(text.charCodeAt(start))) {
		start++;
	}
	if (text[start - 1] !== '\n') {
		const newline = text.indexOf('\n', start);
		if (newline !== -1 && newline - start < step / 2) {
			start = newline + 1;
		}
	}
	return start;
}

/**
 * Offsets that cut `text` into pieces of at least `size` characters, each
 * ending with a line break. Only finished pieces: the text after the last
 * offset is still being written. Appending to `text` never moves an offset.
 */
export function chunkEnds(text: string, size: number): number[] {
	const ends: number[] = [];
	let from = 0;
	for (;;) {
		const newline = text.indexOf('\n', from + size - 1);
		if (newline === -1) {
			return ends;
		}
		from = newline + 1;
		ends.push(from);
	}
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Splits a leading YAML frontmatter block off a Markdown file. */
export function splitFrontmatter(content: string): { frontmatter?: string; body: string } {
	const match = FRONTMATTER.exec(content);
	if (!match) {
		return { body: content.replace(/^﻿/, '') };
	}
	return { frontmatter: match[1] ?? '', body: content.slice(match[0].length) };
}

/** Length of the frontmatter block at the start of `content` (0 if none). */
export function frontmatterLength(content: string): number {
	const match = FRONTMATTER.exec(content);
	return match ? match[0].length : 0;
}

/** File name without directory and extension: `正文/第1章 起.md` → `第1章 起`. */
export function stem(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/** Directory segments of a `/`-separated relative path. */
export function dirSegments(path: string): string[] {
	const parts = path.split('/');
	parts.pop();
	return parts;
}

/** A Markdown code fence long enough to wrap `text` safely. */
export function fenced(text: string, info = 'text'): string {
	const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}${info}\n${text}\n${fence}`;
}
