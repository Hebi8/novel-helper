import { Matcher, type Match } from '../../core/match';
import type { LoreEntry } from '../../core/library';
export class VisibleLore {
	readonly matcher: Matcher;
	constructor(readonly entries: readonly LoreEntry[]) {
		this.matcher = new Matcher(entries.flatMap((entry) => entry.keys.map((key): [string, string] => [key, entry.id])));
	}
	/** Scan the logical lines intersecting the viewport once; retain word boundaries and only decorate visible matches. */
	find(
		text: { lineAt(position: number): { from: number; to: number; text: string } },
		ranges: readonly { from: number; to: number }[],
	): Match[] {
		const matches = new Map<number, Match>();
		const lines = new Map<number, Match[]>();
		for (const range of ranges) {
			let line = text.lineAt(range.from);
			while (line.from <= range.to) {
				let found = lines.get(line.from);
				if (!found) {
					found = this.matcher.find(line.text).map((match) => ({ ...match, start: match.start + line.from, end: match.end + line.from }));
					lines.set(line.from, found);
				}
				for (const match of found) {
					if (match.end > range.from && match.start < range.to) {
						matches.set(match.start, match);
					}
				}
				if (line.to >= range.to) {
					break;
				}
				line = text.lineAt(line.to + 1);
			}
		}
		return [...matches.values()].sort((a, b) => a.start - b.start);
	}
}
