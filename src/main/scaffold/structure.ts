import { assertBookAvailable } from './activity';
import { join, dirname, extname } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { firstNames } from '../../core/scaffold';
import { suggestChapterName, suggestLevelName, nameProblem } from '../../core/book';
import { globFolders, type BookNode } from '../../core/library';
import { MARKER_FILE, namesLanguageOf, parseMarker } from '../../core/story';
import { readOptional } from '../book/files';
import type { BookIndex } from '../book/indexer';
import { defaults, type Settings } from '../../shared/defaults';
import type { StructureAction, StructureInput } from '../../shared/finish';
import { createFile, info, moveAtomic, safePath } from './disk';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
export async function structureSuggestion(index: BookIndex, action: StructureAction, path?: string, settings: Settings = defaults) {
	const tree = index.book.tree;
	const marker = parseMarker((await readOptional(join(index.root, MARKER_FILE))) ?? '');
	const root = index.library.roots('chapter')[0] ?? marker?.folders?.chapters ?? settings['files.chapters'].flatMap(globFolders)[0];
	const first = firstNames(marker?.language ?? namesLanguageOf(root));
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
export async function createStructure(index: BookIndex, input: StructureInput, settings: Settings = defaults): Promise<string> {
	assertBookAvailable(index.root);
	const target = targetLevel(index.book.tree, input.path);
	if (nameProblem(input.name, []) || (input.action === 'level' && nameProblem(input.chapter ?? '', []))) {
		throw new Error(zh.invalidName);
	}
	const marker = parseMarker((await readOptional(join(index.root, MARKER_FILE))) ?? '');
	const root = index.library.roots('chapter')[0] ?? marker?.folders?.chapters ?? settings['files.chapters'].flatMap(globFolders)[0];
	const folder = target.kind === 'book' ? root : target.path;
	const name = input.name.trim();
	// Both text extensions represent the same chapter in the book tree.
	const siblings = (await info(join(index.root, folder))) ? await readdir(join(index.root, folder)) : [];
	if (siblings.some((file) => file === name || file.slice(0, -extname(file).length) === name)) {
		throw new Error(zh.fileExists);
	}
	if (input.action === 'chapter') {
		const path = `${folder}/${name}.md`;
		await createFile(index.root, path, '');
		await index.refresh(path);
		return path;
	}
	const full = await safePath(index.root, `${folder}/${name}`);
	if (await info(full)) {
		throw new Error(zh.fileExists);
	}
	await mkdir(dirname(full), { recursive: true });
	const temporary = `${full}.${randomUUID()}.tmp`;
	await mkdir(temporary);
	try {
		await createFile(temporary, `${input.chapter!.trim()}.md`, '');
		await moveAtomic(temporary, full);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	const path = `${folder}/${name}/${input.chapter!.trim()}.md`;
	await index.refresh(path);
	return path;
}
