import { movedPath } from '../../shared/paths';
import { join, dirname } from 'node:path';
import { readdir, mkdir, link, unlink, rename } from 'node:fs/promises';
import type { Rename } from '../../core/library';
import { nameProblem } from '../../core/book';
import { BUOY_FOLDER, hasOpenMarks, markAt, parseBuoyFile, renameState, serializeBuoyFile } from '../../core/buoy';
import { frontmatterLength } from '../../core/text';
import type { BookIndex } from '../book/indexer';
import { atomicWrite, readOptional } from '../book/files';
import { info, safePath } from './disk';
import { findNode } from './structure';
import { zh } from '../../renderer/strings';
import type { RenameResult } from '../../shared/structure';
async function jsonFiles(root: string, path: string): Promise<string[]> {
	if (!(await info(join(root, path)))) {
		return [];
	}
	await safePath(root, path);
	const entries = await readdir(join(root, path), { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const file = `${path}/${entry.name}`;
				await safePath(root, file);
				return entry.isDirectory() ? jsonFiles(root, file) : entry.name.endsWith('.json') ? [file] : [];
			}),
		)
	).flat();
}
export async function renamePlan(index: BookIndex, path: string, name: string): Promise<Rename[]> {
	const node = findNode(index.book.tree, path);
	if (!node || node.kind === 'book' || nameProblem(name, [])) {
		throw new Error(zh.invalidName);
	}
	name = name.trim();
	if (name === node.name) {
		return [];
	}
	if (name.toLowerCase() === node.name.toLowerCase()) {
		throw new Error(zh.renameCase);
	}
	const plan = index.library.renames(node, name);
	if (plan.blocked) {
		throw new Error(`${zh.renameShared}: ${plan.blocked.path}`);
	}
	const renames = [...plan.renames];
	const buoyFrom = `${BUOY_FOLDER}/${node.path}${node.kind === 'chapter' ? '.json' : ''}`;
	if (await info(join(index.root, buoyFrom))) {
		renames.push({ from: buoyFrom, to: `${BUOY_FOLDER}/${movedPath(node.path, renames)}${node.kind === 'chapter' ? '.json' : ''}` });
	}
	const files: Rename[] = [],
		directories: Rename[] = [];
	for (const move of renames) {
		const source = await safePath(index.root, move.from),
			target = await safePath(index.root, move.to);
		const sourceInfo = await info(source);
		if (!sourceInfo) {
			throw new Error(`${zh.fileMissing}: ${move.from}`);
		}
		if (await info(target)) {
			throw new Error(`${zh.fileExists}: ${move.to}`);
		}
		(sourceInfo.isDirectory() ? directories : files).push(move);
	}
	// A volume's companion files go first, so an unsupported hard-link operation stops before its directories move.
	return [...files, ...directories];
}
async function buoyWrites(index: BookIndex, renames: Rename[]) {
	const writes: { path: string; text: string }[] = [];
	for (const path of await jsonFiles(index.root, BUOY_FOLDER)) {
		const raw = (await readOptional(join(index.root, path)))!;
		const chapter = path.slice(BUOY_FOLDER.length + 1, -'.json'.length);
		const text = hasOpenMarks(raw) ? (await index.read(chapter)).text : '';
		const file = parseBuoyFile(raw, (state) => markAt(text, text.length - frontmatterLength(text), state, 'assistant', new Date()));
		if (!file) {
			throw new Error(`${zh.renameBuoy}: ${path}`);
		}
		const target = movedPath(path, renames);
		const after = {
			...file,
			chapter: target.slice(BUOY_FOLDER.length + 1, -'.json'.length),
			marks: file.marks.map((mark) => ({ ...mark, state: renameState(mark.state, renames) })),
		};
		if (serializeBuoyFile(after) !== serializeBuoyFile(file)) {
			writes.push({ path: target, text: serializeBuoyFile(after) });
		}
	}
	return writes;
}
const diskOperations = { link, unlink, rename, write: atomicWrite };
/** Preflight first; on an unexpected failure report the actual completed moves without rolling them back. */
export async function renameBook(index: BookIndex, path: string, name: string, disk = diskOperations): Promise<RenameResult> {
	const plan = await renamePlan(index, path, name);
	if (!plan.length) {
		return { renames: [] };
	}
	const writes = await buoyWrites(index, plan);
	const completed: Rename[] = [],
		written: string[] = [];
	let linked: Rename | undefined;
	try {
		for (const move of plan) {
			const from = join(index.root, move.from),
				to = join(index.root, move.to);
			await mkdir(dirname(to), { recursive: true });
			if ((await info(from))!.isDirectory()) {
				await disk.rename(from, to);
			} else {
				await disk.link(from, to);
				linked = move;
				await disk.unlink(from);
				linked = undefined;
			}
			completed.push(move);
		}
		for (const write of writes) {
			await disk.write(join(index.root, write.path), write.text);
			written.push(write.path);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const reason = ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '') ? zh.renameUnsupported : String(error);
		return {
			renames: completed,
			error: zh.renamePartial(
				completed,
				plan.slice(completed.length),
				written,
				writes.slice(written.length).map((write) => write.path),
				linked,
				reason,
			),
		};
	}
	return { renames: completed };
}
