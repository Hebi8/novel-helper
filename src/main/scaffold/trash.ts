import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUOY_FOLDER } from '../../core/buoy';
import type { BookNode } from '../../core/library';
import { comparePaths } from '../../core/naturalSort';
import { errorMessage } from '../../renderer/errors';
import { zh } from '../../renderer/strings';
import type { TrashPreview, TrashResult, TrashTarget } from '../../shared/structure';
import { FileFormatError, isDiskConflictCopy, readOptional } from '../book/files';
import { BookIndex } from '../book/indexer';
import { bookPath } from '../book/paths';
import { info, safePath } from './disk';
import { jsonFiles } from './rename';
import { findNode } from './structure';

async function countWords(root: string, path: string): Promise<number> {
	try {
		const text = await readOptional(join(root, path));
		return text ? Array.from(text.replace(/\s/gu, '')).length : 0;
	} catch (error) {
		if (error instanceof FileFormatError) {
			return 0;
		}
		throw error;
	}
}

function sublevelUnitOf(node: BookNode): string {
	const childLevels = node.children.filter((child) => child.kind === 'level');
	const units = [
		...new Set(
			childLevels
				.map((child) => /^第?[零一二三四五六七八九十百千万\d]+\s*([部卷幕篇辑集])/u.exec(child.name)?.[1])
				.filter((unit): unit is string => Boolean(unit)),
		),
	];
	return units.length === 1 ? units[0] : '幕';
}

function descendants(node: BookNode): { levels: BookNode[]; chapters: BookNode[] } {
	const levels: BookNode[] = [];
	const chapters: BookNode[] = [];
	const visit = (item: BookNode) => {
		for (const child of item.children) {
			if (child.kind === 'level') {
				levels.push(child);
				visit(child);
			} else if (child.kind === 'chapter') {
				chapters.push(child);
			}
		}
	};
	if (node.kind === 'chapter') {
		chapters.push(node);
	} else {
		visit(node);
	}
	return { levels, chapters };
}

async function listTree(root: string, rel: string): Promise<string[]> {
	await safePath(root, rel);
	const stat = await info(join(root, rel));
	if (!stat) {
		return [];
	}
	if (!stat.isDirectory()) {
		return [rel];
	}
	const entries = (await readdir(join(root, rel))).sort(comparePaths);
	const nested = await Promise.all(entries.map((name) => listTree(root, `${rel}/${name}`)));
	return [rel, ...nested.flat()];
}

function samePathSet(a: readonly string[], b: readonly string[]): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	return setA.size === setB.size && [...setA].every((item) => setB.has(item));
}

async function snapshotIndex(index: BookIndex): Promise<BookIndex> {
	const fresh = new BookIndex(index.root, index.configuration, index.icloudRoot);
	await fresh.load();
	return fresh;
}

async function resolveTrashFrom(index: BookIndex, target: TrashTarget): Promise<TrashPreview> {
	const path = bookPath(target.path);
	if (target.kind === 'lore') {
		const entry = index.library.entry(path);
		if (!entry) {
			throw new Error(zh.fileMissing);
		}
		const targets = [path];
		const scope = await listTree(index.root, path);
		if (!scope.length) {
			throw new Error(zh.fileMissing);
		}
		const words = await countWords(index.root, path);
		return {
			kind: 'lore',
			name: entry.name,
			path,
			targets,
			scope,
			sublevels: 0,
			sublevelUnit: '幕',
			chapters: 0,
			words,
			outlines: 0,
			summaries: 0,
			hasBuoys: false,
		};
	}
	const node = findNode(index.book.tree, path);
	if (!node || node.kind === 'book') {
		throw new Error(zh.fileMissing);
	}
	const { targets: libTargets, outlines, summaries } = index.library.trashTargets(node);
	const buoyTarget = `${BUOY_FOLDER}/${node.path}${node.kind === 'chapter' ? '.json' : ''}`;
	let buoyExists = Boolean(await info(join(index.root, buoyTarget)));
	let hasBuoys = false;
	if (buoyExists) {
		if (node.kind === 'chapter') {
			if (await isDiskConflictCopy(index.root, buoyTarget, index.inICloud)) {
				buoyExists = false;
			} else {
				hasBuoys = true;
			}
		} else {
			hasBuoys = (await jsonFiles(index.root, buoyTarget, index.inICloud)).length > 0;
		}
	}
	const targets = buoyExists ? [...libTargets, buoyTarget] : [...libTargets];
	const scope = (await Promise.all(targets.map((item) => listTree(index.root, item)))).flat();
	const { levels, chapters } = descendants(node);
	const words = (await Promise.all(chapters.map((chapter) => countWords(index.root, chapter.path)))).reduce((sum, n) => sum + n, 0);
	return {
		kind: node.kind,
		name: node.name,
		path: node.path,
		targets,
		scope,
		sublevels: levels.length,
		sublevelUnit: sublevelUnitOf(node),
		chapters: chapters.length,
		words,
		outlines: outlines.length,
		summaries: summaries.length,
		hasBuoys,
	};
}

export async function trashPlan(index: BookIndex, target: TrashTarget): Promise<TrashPreview> {
	return resolveTrashFrom(await snapshotIndex(index), target);
}

export async function executeTrash(
	index: BookIndex,
	plan: TrashPreview,
	trashItem: (fullPath: string) => Promise<void>,
): Promise<TrashResult> {
	const fresh = await snapshotIndex(index);
	if (fresh.book.conflicts.length) {
		throw new Error(zh.assistantSaveFailed);
	}
	const target: TrashTarget = { kind: plan.kind === 'lore' ? 'lore' : 'structure', path: plan.path };
	let current: TrashPreview;
	try {
		current = await resolveTrashFrom(fresh, target);
	} catch (error) {
		if (error instanceof Error && error.message === zh.fileMissing) {
			throw new Error(zh.trashChanged);
		}
		throw error;
	}
	if (!samePathSet(current.targets, plan.targets) || !samePathSet(current.scope, plan.scope)) {
		throw new Error(zh.trashChanged);
	}
	const trashed: string[] = [];
	let failure: string | undefined;
	for (const item of plan.targets) {
		try {
			await trashItem(join(index.root, item));
			trashed.push(item);
		} catch (error) {
			failure = errorMessage(error);
			break;
		}
	}
	index.untrackRemoved(trashed);
	if (failure !== undefined) {
		return {
			trashed,
			error: zh.trashPartial(trashed, plan.targets.slice(trashed.length), failure),
		};
	}
	return { trashed };
}
