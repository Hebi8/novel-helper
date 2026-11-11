// Names for what the sidebar creates in the book's tree: the chapter after
// the last one, the volume after the last one.

import type { BookNode } from './library';
import { firstName, nextName } from './names';

function chapters(node: BookNode): BookNode[] {
	return node.kind === 'chapter' ? [node] : node.children.flatMap(chapters);
}

function levelsAt(node: BookNode, depth: number): BookNode[] {
	const levels = node.children.filter((child) => child.kind === 'level');
	return depth === 0 ? levels : levels.flatMap((level) => levelsAt(level, depth - 1));
}

/** What `pick` gives for the last of `nodes` it gives anything for. */
function last(nodes: BookNode[], pick: (name: string) => string | undefined): string | undefined {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const picked = pick(nodes[i].name);
		if (picked !== undefined) {
			return picked;
		}
	}
	return undefined;
}

/**
 * A name to start a new chapter in `target` (the book or a level) with: the
 * number after its last numbered chapter, or, when it has none, after the
 * book's (chapter numbers run on from one volume to the next). `first` when
 * the book has no numbered chapter.
 */
export function suggestChapterName(book: BookNode, target: BookNode, first: string): string {
	return last(chapters(target), nextName) ?? last(chapters(book), nextName) ?? first;
}

/**
 * A name to start a new level inside `parent` with: the number after its
 * last numbered level, or the first number in the style of the levels that
 * deep elsewhere in the book (第一幕 after 第三幕 回潮). `first` when there is
 * nothing to go by.
 */
export function suggestLevelName(book: BookNode, parent: BookNode, first: string): string {
	const depth = parent.kind === 'book' ? 0 : parent.dirs.length + 1;
	return last(levelsAt(parent, 0), nextName) ?? last(levelsAt(book, depth), firstName) ?? first;
}

export type NameProblem = 'empty' | 'separator' | 'taken';

/** Why `name` cannot name a new file or folder next to `siblings`. */
export function nameProblem(name: string, siblings: readonly string[]): NameProblem | undefined {
	if (!name.trim() || /^\.+$/.test(name.trim())) {
		return 'empty';
	}
	if (/[\\/]/.test(name)) {
		return 'separator';
	}
	return siblings.includes(name.trim()) ? 'taken' : undefined;
}
