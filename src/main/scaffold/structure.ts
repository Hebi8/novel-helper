import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { firstNames } from '../../core/scaffold';
import { suggestChapterName, suggestLevelName, nameProblem } from '../../core/book';
import type { BookNode } from '../../core/library';
import type { BookIndex } from '../book/indexer';
import { bookFolder, bookNames } from '../book/names';
import type { StructureAction, StructureInput } from '../../shared/structure';
import { createFile, safePath } from './disk';
import { zh } from '../../renderer/strings';
export function findNode(tree: BookNode, path: string): BookNode | undefined {
	return tree.path === path ? tree : tree.children.map((child) => findNode(child, path)).find(Boolean);
}
function parentOf(tree: BookNode, path: string): BookNode | undefined {
	return tree.children.some((child) => child.path === path) ? tree : tree.children.map((child) => parentOf(child, path)).find(Boolean);
}
function lastLevel(node: BookNode): BookNode {
	const last = node.children.at(-1);
	return last && last.kind !== 'chapter' ? lastLevel(last) : node;
}
export function targetLevel(tree: BookNode, path?: string): BookNode {
	const node = path === undefined ? undefined : findNode(tree, path);
	return node?.kind === 'chapter' ? parentOf(tree, node.path)! : (node ?? lastLevel(tree));
}
export async function structureSuggestion(index: BookIndex, action: StructureAction, path?: string) {
	const tree = index.book.tree;
	const first = firstNames(bookNames(index).language);
	const target = targetLevel(tree, path);
	return {
		name:
			action === 'rename'
				? findNode(tree, path!)!.name
				: action === 'chapter'
					? suggestChapterName(tree, target, first.chapter + ' ')
					: suggestLevelName(tree, target, first.volume + ' '),
		chapter: suggestChapterName(tree, { ...target, children: [] }, first.chapter + ' '),
	};
}
export async function createStructure(index: BookIndex, input: StructureInput): Promise<string> {
	const target = targetLevel(index.book.tree, input.path);
	if (
		nameProblem(
			input.name,
			target.children.filter((child) => child.kind === (input.action === 'chapter' ? 'chapter' : 'level')).map((child) => child.name),
		) ||
		(input.action === 'level' && nameProblem(input.chapter ?? '', []))
	) {
		throw new Error(zh.invalidName);
	}
	const folder = target.kind === 'book' ? bookFolder(index, 'chapter') : target.path;
	const name = input.name.trim();
	if (input.action === 'chapter') {
		const path = `${folder}/${name}.md`;
		await createFile(index.root, path, '');
		await index.refresh(path);
		return path;
	}
	const full = await safePath(index.root, `${folder}/${name}`);
	await mkdir(dirname(full), { recursive: true });
	await mkdir(full);
	await createFile(index.root, `${folder}/${name}/${input.chapter!.trim()}.md`, '');
	const path = `${folder}/${name}/${input.chapter!.trim()}.md`;
	await index.refresh(path);
	return path;
}
