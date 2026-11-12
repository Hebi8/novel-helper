// Where on disk a path the agent names really is, and whether a snapshot
// would hold the file there.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { locate, type Where } from '../core/permission';
import { looksBinary, MAX_FILE_BYTES, skipsFolder } from '../core/snapshot';

/** `file` with the links on the way to it resolved. What is not there yet (a file about to be made) keeps its name below the nearest folder that is. */
async function real(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch {
		const parent = path.dirname(file);
		return parent === file ? file : path.join(await real(parent), path.basename(file));
	}
}

/** Whether snapshots hold the file at this place of the story folder, so that changing it can be gone back from. A file that is not there yet counts: making it is found. */
async function kept(story: string, file: string): Promise<boolean> {
	const folders = path.relative(story, file).split(path.sep).slice(0, -1);
	if (folders.some((_, depth) => skipsFolder(folders.slice(0, depth + 1).join('/')))) {
		return false;
	}
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat) {
		return true;
	}
	return stat.isFile() && stat.size <= MAX_FILE_BYTES && !looksBinary(await fs.readFile(file));
}

/**
 * Where a path the agent gave is, seen from the story folder. Links are
 * followed first, so a link inside the folder that points out of it counts
 * as outside. A place inside that snapshots do not hold (a folder, a file
 * that is not text or is very large) is `unkept`.
 */
export async function whereIs(story: string, file: string): Promise<Where> {
	const root = await real(story);
	const full = await real(path.resolve(story, file));
	const where = locate(root, full);
	return where === 'inside' && !(await kept(root, full)) ? 'unkept' : where;
}
