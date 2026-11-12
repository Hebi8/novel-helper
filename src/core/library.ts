// The workspace index: lore entries parsed from Markdown files, the chapter,
// outline and summary file lists, and the book's structure (the book, its
// volumes and arcs, its chapters) read off the folders the chapters are in.
// It knows nothing about VS Code; the extension feeds it paths (relative,
// `/`-separated) and file contents.

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

/** File names (extension aside) of the whole book's outline and summary. */
export const DEFAULT_BOOK_NAMES = ['全书', '总纲', 'book'];

// How many leading folders of a glob are fixed, which is where the files it
// matches are rooted: `{正文,章节}/**/*.md` → 1, `稿子/正文/**/*.md` → 2, `**/*.md` → 0.
export function globRootDepth(glob: string): number {
	const segments = glob.split('/');
	const wild = segments.findIndex((segment) => /[*?[]/.test(segment));
	return wild === -1 ? segments.length - 1 : wild;
}

// The folders a glob's files are rooted in, one per alternative of its leading
// braces: `{正文,章节}/**/*.md` → 正文, 章节; `稿子/正文/**/*.md` → 稿子/正文; `**/*.md` → ''.
export function globFolders(glob: string): string[] {
	let folders = [''];
	for (const segment of glob.split('/').slice(0, globRootDepth(glob))) {
		const braces = /^\{([^{}]*)\}$/.exec(segment);
		const names = braces ? braces[1].split(',') : [segment];
		folders = folders.flatMap((folder) => names.map((name) => (folder ? `${folder}/${name}` : name)));
	}
	return folders;
}

/** The whole book, or one folder level between the chapters folder and a chapter (卷, 幕…). */
export interface Level {
	/** Folder path relative to the workspace folder; '' for the whole book. */
	path: string;
	/** Folder name; for the whole book, the name of its outline file (全书). */
	name: string;
	outline?: string;
	summary?: string;
}

/** The book as a tree of levels and chapters in reading order. */
export interface BookNode extends Level {
	kind: 'book' | 'level' | 'chapter';
	/** The levels this one is in, outermost first: [第一卷] for 正文/第一卷/第一幕 and for 正文/第一卷/第1章.md. */
	dirs: string[];
	children: BookNode[];
}

export interface Rename {
	from: string;
	to: string;
}

/**
 * The moves of a rename; or, when it cannot be done without taking
 * something from another chapter or level, the file or folder in the way
 * and the chapters and levels that share it (none: it sits inside a folder
 * that moves as well).
 */
export type RenamePlan = { renames: Rename[]; blocked?: undefined } | { blocked: { path: string; sharedBy: string[] }; renames?: undefined };

type Companion = 'outline' | 'summary';

export class Library {
	private readonly lore = new Map<string, LoreEntry>();
	private chapters: string[] = [];
	/** Folders of each chapter below the chapters folder: 正文/第一卷/第一幕/第1章.md → [第一卷, 第一幕]. */
	private readonly chapterDirs = new Map<string, string[]>();
	/** By file name (extension aside): path → its folders below the outline or summary folder. */
	private readonly companions: Record<Companion, Map<string, Map<string, string[]>>> = {
		outline: new Map(),
		summary: new Map(),
	};
	private cachedMatcher?: Matcher;
	private cachedEntries?: LoreEntry[];

	constructor(private readonly bookNames: readonly string[] = DEFAULT_BOOK_NAMES) {}

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

	/**
	 * `rootDepth` is how many leading folders of `path` are the chapters (or
	 * outline, or summary) folder itself rather than part of the book's
	 * structure: 1 for 正文/第一卷/第1章.md. See `globRootDepth`.
	 */
	addFile(kind: FileKind, path: string, rootDepth = 1): void {
		const dirs = dirSegments(path).slice(rootDepth);
		if (kind === 'chapter') {
			if (!this.chapterDirs.has(path)) {
				this.chapters.push(path);
				this.chapters.sort(comparePaths);
			}
			this.chapterDirs.set(path, dirs);
			return;
		}
		const byName = this.companions[kind];
		const paths = byName.get(stem(path)) ?? new Map<string, string[]>();
		paths.set(path, dirs);
		byName.set(stem(path), paths);
	}

	deleteFile(kind: FileKind, path: string): void {
		if (kind === 'chapter') {
			this.chapters = this.chapters.filter((p) => p !== path);
			this.chapterDirs.delete(path);
			return;
		}
		this.companions[kind].get(stem(path))?.delete(path);
	}

	/** No chapters, no lore, no outlines or summaries: nothing of a novel in the folder yet. */
	get empty(): boolean {
		const none = (kind: Companion) => [...this.companions[kind].values()].every((paths) => paths.size === 0);
		return this.chapters.length === 0 && this.lore.size === 0 && none('outline') && none('summary');
	}

	isChapter(path: string): boolean {
		return this.chapterDirs.has(path);
	}

	/** Chapters in reading order. */
	chapterList(): readonly string[] {
		return this.chapters;
	}

	/** Every outline file with its folders below the outline folder, and the one for the whole book. */
	outlines(): { files: Array<{ path: string; dirs: string[] }>; book: Level } {
		const files = [...this.companions.outline.values()].flatMap((paths) => [...paths].map(([path, dirs]) => ({ path, dirs })));
		return { files, book: this.book() };
	}

	/** Up to `count` chapters right before `path`, oldest first. */
	previousChapters(path: string, count: number): string[] {
		const index = this.chapters.indexOf(path);
		return index <= 0 || count <= 0 ? [] : this.chapters.slice(Math.max(0, index - count), index);
	}

	/**
	 * The outline or summary file for a chapter: same file name (extension
	 * aside), in the same folders below the outline folder as the chapter is
	 * below the chapters folder, or in fewer of them: 正文/卷二/第1章.md takes
	 * 大纲/卷二/第1章.md, else 大纲/第1章.md, never 大纲/卷一/第1章.md.
	 */
	companionOf(kind: Companion, chapterPath: string): string | undefined {
		return this.companion(kind, stem(chapterPath), this.chapterDirs.get(chapterPath) ?? []);
	}

	/**
	 * The levels above a chapter, the whole book first. Every folder between
	 * the chapters folder and the chapter is a level, however deep:
	 * 正文/第一卷/第一幕/第1章.md → 全书, 第一卷, 第一幕. A level's outline and
	 * summary are the files named after its folder, placed like a chapter's:
	 * 大纲/第一卷.md, 大纲/第一卷/第一幕.md. The book's are named 全书 (or
	 * another of the book names) and sit right in the outline or summary
	 * folder. Files that are not chapters get the book alone.
	 */
	levelsOf(chapterPath: string): Level[] {
		const dirs = this.chapterDirs.get(chapterPath) ?? [];
		const folders = dirSegments(chapterPath);
		const root = folders.slice(0, folders.length - dirs.length);
		const levels = [this.book()];
		for (let depth = 1; depth <= dirs.length; depth++) {
			const name = dirs[depth - 1];
			const parents = dirs.slice(0, depth - 1);
			levels.push({
				path: [...root, ...dirs.slice(0, depth)].join('/'),
				name,
				outline: this.companion('outline', name, parents),
				summary: this.companion('summary', name, parents),
			});
		}
		return levels;
	}

	/** Levels and chapters in reading order; a level shows up once it holds a chapter. */
	tree(): BookNode {
		const root: BookNode = { kind: 'book', ...this.book(), dirs: [], children: [] };
		const levels = new Map<string, BookNode>();
		for (const chapter of this.chapters) {
			const dirs = this.chapterDirs.get(chapter)!;
			let parent = root;
			this.levelsOf(chapter).slice(1).forEach((level, depth) => {
				let node = levels.get(level.path);
				if (!node) {
					node = { kind: 'level', ...level, dirs: dirs.slice(0, depth), children: [] };
					levels.set(level.path, node);
					parent.children.push(node);
				}
				parent = node;
			});
			parent.children.push({
				kind: 'chapter',
				path: chapter,
				name: stem(chapter),
				outline: this.companionOf('outline', chapter),
				summary: this.companionOf('summary', chapter),
				dirs,
				children: [],
			});
		}
		return root;
	}

	/**
	 * The folders the files of a kind are rooted in (正文, 大纲…), the one
	 * holding the most files first; empty when there are no such files yet.
	 */
	roots(kind: FileKind): string[] {
		const counts = new Map<string, number>();
		const count = (path: string, dirs: string[]) => {
			const folders = dirSegments(path);
			const root = folders.slice(0, folders.length - dirs.length).join('/');
			counts.set(root, (counts.get(root) ?? 0) + 1);
		};
		if (kind === 'chapter') {
			this.chapterDirs.forEach((dirs, path) => count(path, dirs));
		} else {
			this.companions[kind].forEach((paths) => paths.forEach((dirs, path) => count(path, dirs)));
		}
		return [...counts].sort((a, b) => b[1] - a[1] || comparePaths(a[0], b[0])).map(([root]) => root);
	}

	/**
	 * What has to move to rename a chapter or a level of `tree()` and keep
	 * its outline and summary with it. A chapter: its file and the two that
	 * go with it. A level: its folder, the outline and summary named after
	 * it, and the folders that stand for it under the outline and summary
	 * folders (大纲/第一卷/…). Files keep their extensions.
	 *
	 * Nothing is moved when that could take something away from another
	 * chapter or level: an outline two chapters share, a folder that holds
	 * the outlines of two volumes' same-named arcs. The plan then says what
	 * is shared and by whom.
	 */
	renames(node: BookNode, newName: string): RenamePlan {
		const renamed = (path: string) => {
			const slash = path.lastIndexOf('/') + 1;
			return { from: path, to: path.slice(0, slash) + newName + path.slice(slash + stem(path).length) };
		};
		const uses = this.uses();
		const users = (path: string) => [...new Set(uses.filter((use) => use.file === path).map((use) => use.user))];
		const files = [node.outline, node.summary].filter((path): path is string => path !== undefined);
		for (const file of files) {
			if (users(file).length > 1) {
				return { blocked: { path: file, sharedBy: users(file) } };
			}
		}
		if (node.kind === 'chapter') {
			return { renames: [node.path, ...files].map(renamed) };
		}
		// Which levels each folder under the outline and summary folders stands for, going by the files in use below it.
		const owners = new Map<string, Set<string>>();
		for (const use of uses) {
			use.folders.forEach((level, folder) => owners.set(folder, (owners.get(folder) ?? new Set()).add(level)));
		}
		const chain = [...node.dirs, node.name];
		const namesakes = this.levels().filter((level) => level.name === node.name);
		const folders: string[] = [];
		for (const [folder, own] of this.mirrors()) {
			const owned = owners.get(folder);
			if (owned) {
				if (!owned.has(node.path)) {
					continue;
				}
				if (owned.size > 1) {
					return { blocked: { path: folder, sharedBy: [...owned] } };
				}
				folders.push(folder);
			} else if (isTail(own, chain) && namesakes.every((level) => level.path === node.path || !isTail(own, [...level.dirs, level.name]))) {
				// Nothing in it is in use yet (outlines written ahead): it goes along when it can only be this level's.
				folders.push(folder);
			}
		}
		const moved = [node.path, ...folders].map((from) => ({ from, to: from.slice(0, from.lastIndexOf('/') + 1) + newName }));
		const all = [...moved, ...files.map(renamed)];
		// A folder that moves takes what is in it along: nothing else may be renamed from inside it.
		const inside = all.find((one) => all.some((other) => one.from.startsWith(`${other.from}/`)));
		return inside ? { blocked: { path: inside.from, sharedBy: [] } } : { renames: all };
	}

	/** Every level of the book. */
	private levels(node: BookNode = this.tree()): BookNode[] {
		return node.children.filter((child) => child.kind === 'level').flatMap((level) => [level, ...this.levels(level)]);
	}

	/**
	 * Each outline and summary file that a chapter or level takes, with who
	 * takes it, and, for every folder between the outline (or summary)
	 * folder and the file, the level that folder stands for: for
	 * 正文/卷一/第一幕/第1章.md taking 大纲/第一幕/第1章.md, 大纲/第一幕 stands
	 * for 正文/卷一/第一幕.
	 */
	private uses(): Array<{ file: string; user: string; folders: Map<string, string> }> {
		const uses: Array<{ file: string; user: string; folders: Map<string, string> }> = [];
		const visit = (node: BookNode) => {
			for (const kind of ['outline', 'summary'] as const) {
				const file = node[kind];
				if (node.kind === 'book' || !file) {
					continue;
				}
				const own = this.companions[kind].get(stem(file))!.get(file)!;
				const fileFolders = dirSegments(file);
				// The folders the user is in; the last of them line up with the file's folders.
				const nodeFolders = dirSegments(node.path);
				const folders = new Map<string, string>();
				own.forEach((_, i) => {
					folders.set(
						fileFolders.slice(0, fileFolders.length - own.length + i + 1).join('/'),
						nodeFolders.slice(0, nodeFolders.length - own.length + i + 1).join('/'),
					);
				});
				uses.push({ file, user: node.path, folders });
			}
			node.children.forEach(visit);
		};
		visit(this.tree());
		return uses;
	}

	/** Every folder below the outline and summary folders that holds files, with its folders below that root. */
	private mirrors(): Map<string, string[]> {
		const mirrors = new Map<string, string[]>();
		for (const kind of ['outline', 'summary'] as const) {
			for (const paths of this.companions[kind].values()) {
				for (const [path, own] of paths) {
					const folders = dirSegments(path);
					own.forEach((_, i) => mirrors.set(folders.slice(0, folders.length - own.length + i + 1).join('/'), own.slice(0, i + 1)));
				}
			}
		}
		return mirrors;
	}

	private book(): Level {
		const outline = this.bookFile('outline');
		return {
			path: '',
			name: outline ? stem(outline) : this.bookNames[0] ?? '',
			outline,
			summary: this.bookFile('summary'),
		};
	}

	/** The file named after the book right in an outline (or summary) folder; the first book name wins. */
	private bookFile(kind: Companion): string | undefined {
		for (const name of this.bookNames) {
			const path = this.companion(kind, name, []);
			if (path) {
				return path;
			}
		}
		return undefined;
	}

	/** The file called `name` whose folders are the longest tail of `dirs`. */
	private companion(kind: Companion, name: string, dirs: string[]): string | undefined {
		let best: string | undefined;
		let bestDepth = -1;
		for (const [path, own] of this.companions[kind].get(name) ?? []) {
			if (!isTail(own, dirs)) {
				continue;
			}
			if (own.length > bestDepth || (own.length === bestDepth && comparePaths(path, best!) < 0)) {
				best = path;
				bestDepth = own.length;
			}
		}
		return best;
	}
}

function isTail(tail: string[], dirs: string[]): boolean {
	return tail.length <= dirs.length && tail.every((dir, i) => dir === dirs[dirs.length - tail.length + i]);
}
