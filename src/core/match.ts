// Finds lore names and aliases in prose. Chinese has no spaces, so plain
// substring search would let 「张三」 fire inside 「张三丰」; instead the text is
// segmented left to right, always taking the longest key that matches at each
// position. Keys that start or end with a Latin letter or digit also need a
// word boundary on that side, so `Al` does not fire inside `Also`.

export interface Match {
	start: number;
	end: number;
	/** The key as it was written in the lore file. */
	key: string;
	/** Ids of every entry that owns this key. */
	ids: string[];
}

interface Node {
	next: Map<string, Node>;
	key?: string;
}

function fold(c: string): string {
	return c >= 'A' && c <= 'Z' ? c.toLowerCase() : c;
}

function isWordChar(c: string | undefined): boolean {
	return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

export class Matcher {
	private readonly root: Node = { next: new Map() };
	private readonly owners = new Map<string, string[]>();
	private readonly written = new Map<string, string>();

	/** `keys` are `[key, entryId]` pairs. */
	constructor(keys: Iterable<[string, string]>) {
		for (const [rawKey, id] of keys) {
			const key = rawKey.trim();
			if (key) {
				this.add(key, id);
			}
		}
	}

	get size(): number {
		return this.owners.size;
	}

	private add(key: string, id: string): void {
		const folded = Array.from(key, fold).join('');
		let node = this.root;
		// Walk UTF-16 code units, as longestAt() does, so surrogate pairs line up.
		for (let i = 0; i < folded.length; i++) {
			const c = folded[i];
			let next = node.next.get(c);
			if (!next) {
				next = { next: new Map() };
				node.next.set(c, next);
			}
			node = next;
		}
		node.key = folded;
		const ids = this.owners.get(folded) ?? [];
		if (!ids.includes(id)) {
			ids.push(id);
		}
		this.owners.set(folded, ids);
		if (!this.written.has(folded)) {
			this.written.set(folded, key);
		}
	}

	/** All matches in `text`, left to right, non-overlapping. */
	find(text: string): Match[] {
		const matches: Match[] = [];
		let i = 0;
		while (i < text.length) {
			const match = this.longestAt(text, i);
			if (match) {
				matches.push(match);
				i = match.end;
			} else {
				i++;
			}
		}
		return matches;
	}

	/** The match that covers `offset` in `text` (a match ending exactly at `offset` also counts). */
	at(text: string, offset: number): Match | undefined {
		const matches = this.find(text);
		return (
			matches.find((m) => m.start <= offset && offset < m.end) ??
			matches.find((m) => m.end === offset)
		);
	}

	private longestAt(text: string, start: number): Match | undefined {
		const ends: Array<{ end: number; key: string }> = [];
		let node: Node | undefined = this.root;
		for (let j = start; j < text.length; j++) {
			node = node.next.get(fold(text[j]));
			if (!node) {
				break;
			}
			if (node.key !== undefined) {
				ends.push({ end: j + 1, key: node.key });
			}
		}
		for (let k = ends.length - 1; k >= 0; k--) {
			const { end, key } = ends[k];
			if (isWordChar(key[0]) && isWordChar(text[start - 1])) {
				continue;
			}
			if (isWordChar(key[key.length - 1]) && isWordChar(text[end])) {
				continue;
			}
			return { start, end, key: this.written.get(key)!, ids: this.owners.get(key)! };
		}
		return undefined;
	}
}

export interface Hit {
	id: string;
	/** Occurrences in the scanned text before the cursor. */
	count: number;
	/** Characters between the closest occurrence and the cursor; undefined if the entry only appears in the outline. */
	nearest?: number;
	/** How often each key of the entry matched. */
	keys: Map<string, number>;
	inOutline: boolean;
	score: number;
}

/** Characters at which a mention counts half as much as one right at the cursor. */
export const DISTANCE_HALF_WEIGHT = 500;
/** Weight of being named in this chapter's outline. */
export const OUTLINE_WEIGHT = 0.5;

/**
 * Ranks entries by how relevant they are at the cursor: every mention adds
 * `1 / (1 + distance / 500)`, so a mention right before the cursor counts 1 and
 * one 500 characters back counts 0.5; being named in the outline adds 0.5.
 * `textMatches` come from text that ends at the cursor (`cursor` = its length).
 */
export function rankHits(textMatches: Match[], cursor: number, outlineMatches: Match[] = []): Hit[] {
	const hits = new Map<string, Hit>();
	const hitFor = (id: string): Hit => {
		let hit = hits.get(id);
		if (!hit) {
			hit = { id, count: 0, keys: new Map(), inOutline: false, score: 0 };
			hits.set(id, hit);
		}
		return hit;
	};
	for (const m of textMatches) {
		const distance = Math.max(0, cursor - m.end);
		for (const id of m.ids) {
			const hit = hitFor(id);
			hit.count++;
			hit.keys.set(m.key, (hit.keys.get(m.key) ?? 0) + 1);
			hit.nearest = hit.nearest === undefined ? distance : Math.min(hit.nearest, distance);
			hit.score += 1 / (1 + distance / DISTANCE_HALF_WEIGHT);
		}
	}
	for (const m of outlineMatches) {
		for (const id of m.ids) {
			const hit = hitFor(id);
			if (!hit.inOutline) {
				hit.inOutline = true;
				hit.score += OUTLINE_WEIGHT;
			}
		}
	}
	return [...hits.values()].sort(
		(a, b) =>
			b.score - a.score ||
			(a.nearest ?? Infinity) - (b.nearest ?? Infinity) ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
}
