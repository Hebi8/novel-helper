// The workspace index: lore entries parsed from Markdown files, plus the
// chapter, outline and summary file lists. It knows nothing about VS Code;
// the extension feeds it paths (relative, `/`-separated) and file contents.

import { parse as parseYaml } from 'yaml';
import { Matcher } from './match';
import { comparePaths } from './naturalSort';
import { dirSegments, splitFrontmatter, stem } from './text';

export interface LoreEntry {
	/** Relative path of the file; unique. */
	id: string;
	name: string;
	aliases: string[];
	type?: string;
	/** Sent with every request, matched or not. */
	always: boolean;
	summary?: string;
	/** File content without frontmatter, trimmed. */
	body: string;
	/** Name plus aliases, deduplicated. */
	keys: string[];
	/** Set when the frontmatter is not valid YAML; the entry then falls back to defaults. */
	error?: string;
}

function scalar(value: unknown): string | undefined {
	if (typeof value === 'string' || typeof value === 'number') {
		const text = String(value).trim();
		return text || undefined;
	}
	return undefined;
}

function list(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(scalar).filter((v): v is string => v !== undefined);
	}
	const text = scalar(value);
	return text ? text.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Reads one lore file. Frontmatter fields: `name` (defaults to the file name),
 * `aliases` (list or comma-separated), `type`, `always`, `summary`.
 */
export function parseLoreEntry(path: string, content: string): LoreEntry {
	const { frontmatter, body } = splitFrontmatter(content);
	let data: Record<string, unknown> = {};
	let error: string | undefined;
	if (frontmatter !== undefined) {
		try {
			const parsed: unknown = parseYaml(frontmatter);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
	const name = scalar(data.name) ?? stem(path);
	const aliases = list(data.aliases).filter((alias) => alias !== name);
	return {
		id: path,
		name,
		aliases,
		type: scalar(data.type),
		always: data.always === true,
		summary: scalar(data.summary),
		body: body.trim(),
		keys: [...new Set([name, ...aliases])],
		error,
	};
}

export type FileKind = 'chapter' | 'outline' | 'summary';

export class Library {
	private readonly lore = new Map<string, LoreEntry>();
	private chapters: string[] = [];
	private readonly companions: Record<'outline' | 'summary', Map<string, Set<string>>> = {
		outline: new Map(),
		summary: new Map(),
	};
	private cachedMatcher?: Matcher;
	private cachedEntries?: LoreEntry[];

	setLore(path: string, content: string): LoreEntry {
		const entry = parseLoreEntry(path, content);
		this.lore.set(path, entry);
		this.cachedMatcher = undefined;
		this.cachedEntries = undefined;
		return entry;
	}

	deleteLore(path: string): void {
		if (this.lore.delete(path)) {
			this.cachedMatcher = undefined;
			this.cachedEntries = undefined;
		}
	}

	entry(id: string): LoreEntry | undefined {
		return this.lore.get(id);
	}

	/** All entries in path order. */
	entries(): LoreEntry[] {
		this.cachedEntries ??= [...this.lore.values()].sort((a, b) => comparePaths(a.id, b.id));
		return this.cachedEntries;
	}

	matcher(): Matcher {
		this.cachedMatcher ??= new Matcher(this.entries().flatMap((e) => e.keys.map((k): [string, string] => [k, e.id])));
		return this.cachedMatcher;
	}

	addFile(kind: FileKind, path: string): void {
		if (kind === 'chapter') {
			if (!this.chapters.includes(path)) {
				this.chapters.push(path);
				this.chapters.sort(comparePaths);
			}
			return;
		}
		const byStem = this.companions[kind];
		const key = stem(path);
		const paths = byStem.get(key) ?? new Set<string>();
		paths.add(path);
		byStem.set(key, paths);
	}

	deleteFile(kind: FileKind, path: string): void {
		if (kind === 'chapter') {
			this.chapters = this.chapters.filter((p) => p !== path);
			return;
		}
		this.companions[kind].get(stem(path))?.delete(path);
	}

	isChapter(path: string): boolean {
		return this.chapters.includes(path);
	}

	/** Chapters in reading order. */
	chapterList(): readonly string[] {
		return this.chapters;
	}

	/** Up to `count` chapters right before `path`, oldest first. */
	previousChapters(path: string, count: number): string[] {
		const index = this.chapters.indexOf(path);
		return index <= 0 || count <= 0 ? [] : this.chapters.slice(Math.max(0, index - count), index);
	}

	/**
	 * The outline or summary file for a chapter: same file name (extension
	 * aside); when several match, the one whose directories line up best with
	 * the chapter's (大纲/卷二/第1章 for 正文/卷二/第1章).
	 */
	companionOf(kind: 'outline' | 'summary', chapterPath: string): string | undefined {
		const candidates = this.companions[kind].get(stem(chapterPath));
		if (!candidates) {
			return undefined;
		}
		const dirs = dirSegments(chapterPath);
		let best: string | undefined;
		let bestScore = -1;
		for (const candidate of candidates) {
			const score = commonSuffixLength(dirSegments(candidate), dirs);
			if (score > bestScore || (score === bestScore && best !== undefined && comparePaths(candidate, best) < 0)) {
				best = candidate;
				bestScore = score;
			}
		}
		return best;
	}
}

function commonSuffixLength(a: string[], b: string[]): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
		n++;
	}
	return n;
}
