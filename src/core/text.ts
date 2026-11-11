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
