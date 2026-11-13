export interface SearchMatch {
	line: number;
	column: number;
	offset: number;
	length: number;
	text: string;
}
export interface SearchResult {
	total: number;
	groups: { path: string; matches: SearchMatch[] }[];
	skipped: { path: string; reason: string }[];
}
/** A short excerpt that keeps the match visible even in a long prose paragraph. */
export function searchExcerpt(match: SearchMatch) {
	const from = Math.max(0, match.column - 35),
		to = Math.min(match.text.length, match.column + match.length + 65);
	return {
		before: (from ? '…' : '') + match.text.slice(from, match.column),
		hit: match.text.slice(match.column, match.column + match.length),
		after: match.text.slice(match.column + match.length, to) + (to < match.text.length ? '…' : ''),
	};
}
