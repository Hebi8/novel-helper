// The outline as a graph. Its nodes are the folders below the outline
// folder, the files in them, and the heading sections of each file; the tree
// is folder → file → headings, with the whole book's outline file as the
// root. A file and the folder of the same name next to it are one node: the
// file says what the folder is about. The leaves, in the order they come
// (files in natural order, headings as written), are the main line of the
// story: each leads to the next. A line `→ title` in a node adds a way from
// that node to another: a branch, a merge, a jump.

import { comparePaths } from './naturalSort';
import { frontmatterLength, stem } from './text';

export interface OutlineFile {
	/** Relative to the story folder. */
	path: string;
	/** Its folders below the outline folder: 大纲/第一卷/第1章.md → [第一卷]. */
	dirs: string[];
	content: string;
}

export interface OutlineLink {
	/** What follows the arrow, as written. */
	raw: string;
	/** Undefined when `raw` names no node, or more than one. */
	target?: OutlineNode;
	problem?: 'missing' | 'ambiguous';
}

export interface OutlineNode {
	/**
	 * A file's path; a folder's path with a `/` after it; for a heading, its
	 * file's path, `#`, and the titles of the headings down to it joined by
	 * `/`. '' for a book without an outline file.
	 */
	id: string;
	/** A heading's text; the name of a file (extension aside) or folder. */
	title: string;
	kind: 'book' | 'folder' | 'file' | 'heading';
	/** The file the node is written in; undefined for a folder that has no file of its name. */
	file?: string;
	/** The line of the heading in its file, from 0; 0 for a file. */
	line: number;
	parent?: OutlineNode;
	children: OutlineNode[];
	/** What is written right under it, up to its first sub-heading; `→` lines are not part of it. */
	text: string;
	links: OutlineLink[];
}

export interface OutlineGraph {
	root: OutlineNode;
	nodes: Map<string, OutlineNode>;
	/** The main line: every node without children, in order. Empty when nothing is written in the outline. */
	leaves: OutlineNode[];
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;
const LINK = /^[ \t]*(?:→|->)[ \t]*(.+?)[ \t]*$/;

function node(kind: OutlineNode['kind'], id: string, title: string, file?: string, line = 0): OutlineNode {
	return { id, title, kind, file, line, children: [], text: '', links: [] };
}

function adopt(parent: OutlineNode, children: OutlineNode[]): void {
	for (const child of children) {
		child.parent = parent;
		parent.children.push(child);
	}
}

/**
 * A file as a node with its headings below it. A single `# title` that
 * starts the file is the file's own title, not a node.
 */
function parseFile(file: OutlineFile, kind: 'book' | 'file'): OutlineNode {
	const top = node(kind, file.path, stem(file.path), file.path);
	const skipped = file.content.slice(0, frontmatterLength(file.content)).split('\n').length - 1;
	const lines = file.content.split(/\r?\n/).slice(skipped);
	const headings: Array<{ index: number; level: number; title: string }> = [];
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) {
			fenced = !fenced;
		}
		const match = fenced ? null : HEADING.exec(line);
		if (match?.[2]) {
			headings.push({ index, level: match[1].length, title: match[2] });
		}
	});
	const first = lines.findIndex((line) => line.trim() !== '');
	if (headings[0]?.index === first && headings[0].level === 1 && headings.filter((heading) => heading.level === 1).length === 1) {
		lines[first] = '';
		headings.shift();
	}

	const write = (into: OutlineNode, from: number, to: number) => {
		const kept: string[] = [];
		for (const line of lines.slice(from, to)) {
			const link = LINK.exec(line);
			if (link) {
				into.links.push({ raw: link[1] });
			} else {
				kept.push(line);
			}
		}
		into.text = kept.join('\n').trim();
	};
	write(top, 0, headings[0]?.index ?? lines.length);
	/** The headings the current one is under, with their levels; the file is level 0. */
	const open: Array<{ level: number; node: OutlineNode }> = [{ level: 0, node: top }];
	headings.forEach((heading, i) => {
		while (open[open.length - 1].level >= heading.level) {
			open.pop();
		}
		const parent = open[open.length - 1].node;
		const twins = parent.children.filter((sibling) => sibling.title === heading.title).length;
		const base = parent === top ? `${file.path}#` : `${parent.id}/`;
		const made = node('heading', `${base}${heading.title}${twins ? ` (${twins + 1})` : ''}`, heading.title, file.path, skipped + heading.index);
		adopt(parent, [made]);
		write(made, heading.index + 1, headings[i + 1]?.index ?? lines.length);
		open.push({ level: heading.level, node: made });
	});
	return top;
}

function walk(from: OutlineNode, visit: (node: OutlineNode) => void): void {
	visit(from);
	from.children.forEach((child) => walk(child, visit));
}

export function firstLeaf(of: OutlineNode): OutlineNode {
	return of.children.length ? firstLeaf(of.children[0]) : of;
}

export function lastLeaf(of: OutlineNode): OutlineNode {
	return of.children.length ? lastLeaf(of.children[of.children.length - 1]) : of;
}

/** The nodes above `of`, outermost first; the root is the first. */
export function ancestors(of: OutlineNode): OutlineNode[] {
	return of.parent ? [...ancestors(of.parent), of.parent] : [];
}

/**
 * `files` are all the outline files; `book` is the one for the whole book,
 * if there is one, and the name the book goes by.
 */
export function buildOutline(files: readonly OutlineFile[], book: { file?: string; name: string }): OutlineGraph {
	const bookFile = files.find((file) => file.path === book.file);
	const root = bookFile ? parseFile(bookFile, 'book') : node('book', '', book.name);
	/** Path below the outline folder (extension aside) → the file's node, for links written as paths. */
	const byPath = new Map<string, OutlineNode>();

	// Folder → what is right in it. The outline folders themselves (大纲, 细纲) are the keys files start from.
	const filesIn = new Map<string, OutlineFile[]>();
	const foldersIn = new Map<string, Set<string>>();
	const tops = new Set<string>();
	for (const file of files) {
		if (file === bookFile) {
			continue;
		}
		const folders = file.path.split('/').slice(0, -1);
		const top = folders.slice(0, folders.length - file.dirs.length).join('/');
		tops.add(top);
		let folder = top;
		for (const dir of file.dirs) {
			foldersIn.set(folder, (foldersIn.get(folder) ?? new Set()).add(dir));
			folder = folder ? `${folder}/${dir}` : dir;
		}
		filesIn.set(folder, [...(filesIn.get(folder) ?? []), file]);
	}
	const build = (folder: string, top: string): OutlineNode[] => {
		const inside = (name: string) => (folder ? `${folder}/${name}` : name);
		const folders = new Set(foldersIn.get(folder));
		const made: OutlineNode[] = [];
		for (const file of [...(filesIn.get(folder) ?? [])].sort((a, b) => comparePaths(a.path, b.path))) {
			const parsed = parseFile(file, 'file');
			const below = file.path.slice(top ? top.length + 1 : 0);
			byPath.set(below, parsed);
			byPath.set(inside(parsed.title).slice(top ? top.length + 1 : 0), parsed);
			// The first file named like a folder is that folder's node.
			if (folders.delete(parsed.title)) {
				adopt(parsed, build(inside(parsed.title), top));
			}
			made.push(parsed);
		}
		for (const name of folders) {
			const folderNode = node('folder', `${inside(name)}/`, name);
			adopt(folderNode, build(inside(name), top));
			made.push(folderNode);
		}
		return made.sort((a, b) => comparePaths(a.title, b.title));
	};
	for (const top of [...tops].sort(comparePaths)) {
		adopt(root, build(top, top));
	}

	const nodes = new Map<string, OutlineNode>();
	const leaves: OutlineNode[] = [];
	walk(root, (one) => {
		nodes.set(one.id, one);
		if (!one.children.length && (one !== root || one.file !== undefined)) {
			leaves.push(one);
		}
	});

	const inFile = (file: OutlineNode, title: string) => {
		const found: OutlineNode[] = [];
		walk(file, (one) => {
			if (one.kind === 'heading' && one.file === file.file && one.title === title) {
				found.push(one);
			}
		});
		return found;
	};
	const fileOf = (one: OutlineNode): OutlineNode => (one.kind === 'heading' ? fileOf(one.parent!) : one);
	const resolve = (from: OutlineNode, raw: string): OutlineNode[] => {
		const hash = raw.indexOf('#');
		if (hash !== -1) {
			const path = raw.slice(0, hash).trim();
			const file = path ? (byPath.get(path) ?? nodes.get(path)) : fileOf(from);
			return file ? inFile(file, raw.slice(hash + 1).trim()) : [];
		}
		const named = [...nodes.values()].filter((one) => one.title === raw && one !== from);
		if (named.length > 1) {
			// The one in the same file is meant.
			const near = named.filter((one) => one.file !== undefined && one.file === from.file);
			return near.length === 1 ? near : named;
		}
		const file = byPath.get(raw);
		return named.length || !file ? named : [file];
	};
	for (const one of nodes.values()) {
		for (const link of one.links) {
			const found = resolve(one, link.raw);
			if (found.length === 1) {
				link.target = found[0];
			} else {
				link.problem = found.length ? 'ambiguous' : 'missing';
			}
		}
	}
	return { root, nodes, leaves };
}

export interface Ways {
	/** The leaf after this one on the main line. */
	next?: OutlineNode;
	previous?: OutlineNode;
	/** Where the `→` lines lead: those of the leaf, and those of the nodes it is the last leaf of. */
	linked: OutlineNode[];
}

/** Where the story can go from a leaf. */
export function waysFrom(graph: OutlineGraph, leaf: OutlineNode): Ways {
	const at = graph.leaves.indexOf(leaf);
	const next = at === -1 ? undefined : graph.leaves[at + 1];
	const linked: OutlineNode[] = [];
	for (const from of [leaf, ...ancestors(leaf).reverse().filter((above) => lastLeaf(above) === leaf)]) {
		for (const link of from.links) {
			const target = link.target && firstLeaf(link.target);
			if (target && target !== leaf && target !== next && !linked.includes(target)) {
				linked.push(target);
			}
		}
	}
	return { next, previous: at > 0 ? graph.leaves[at - 1] : undefined, linked };
}

/** `全书 › 第一卷 › 第2章 灯塔 › 周伯收信`: a node with what it is under, the book aside. */
export function trail(of: OutlineNode): string {
	return [...ancestors(of).slice(1), of].map((one) => one.title).join(' › ');
}
