import { movedPath } from '../../shared/paths';
import { join, dirname } from 'node:path';
import { readdir, mkdir, link, unlink, rename } from 'node:fs/promises';
import { conflictOriginal } from '../../core/conflict';
import type { Rename } from '../../core/library';
import { nameProblem } from '../../core/book';
import { BUOY_FOLDER, hasOpenMarks, markAt, parseBuoyFile, renameState, serializeBuoyFile, type BuoyFile } from '../../core/buoy';
import { frontmatterLength, stem } from '../../core/text';
import type { BookIndex } from '../book/indexer';
import { atomicWrite, readOptional } from '../book/files';
import { info, safePath } from './disk';
import { findNode } from './structure';
import { zh } from '../../renderer/strings';
import type { RenameResult } from '../../shared/structure';
export async function jsonFiles(root: string, path: string, inICloud: boolean): Promise<string[]> {
	if (!(await info(join(root, path)))) {
		return [];
	}
	await safePath(root, path);
	const entries = await readdir(join(root, path), { withFileTypes: true });
	const siblings = new Set(entries.filter((entry) => entry.isFile()).map((entry) => `${path}/${entry.name}`));
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const file = `${path}/${entry.name}`;
				await safePath(root, file);
				if (entry.isDirectory()) {
					return jsonFiles(root, file, inICloud);
				}
				return entry.isFile() && entry.name.endsWith('.json') && !conflictOriginal(file, siblings, inICloud, ['.json']) ? [file] : [];
			}),
		)
	).flat();
}
export async function renamePlan(index: BookIndex, path: string, name: string): Promise<Rename[]> {
	const node = findNode(index.book.tree, path);
	if (!node) {
		const loreEntry = index.library.entry(path);
		if (!loreEntry || nameProblem(name, [])) {
			throw new Error(zh.invalidName);
		}
		name = name.trim();
		const oldStem = stem(path);
		if (name === oldStem) {
			return [];
		}
		if (name.toLowerCase() === oldStem.toLowerCase()) {
			throw new Error(zh.renameCase);
		}
		const slash = path.lastIndexOf('/') + 1;
		const to = path.slice(0, slash) + name + path.slice(slash + oldStem.length);
		const source = await safePath(index.root, path);
		const target = await safePath(index.root, to);
		if (!(await info(source))) {
			throw new Error(`${zh.fileMissing}: ${path}`);
		}
		if (await info(target)) {
			throw new Error(`${zh.fileExists}: ${to}`);
		}
		return [{ from: path, to }];
	}
	if (node.kind === 'book' || nameProblem(name, [])) {
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
async function readBuoys(index: BookIndex) {
	const records: { path: string; file: BuoyFile }[] = [];
	for (const path of await jsonFiles(index.root, BUOY_FOLDER, index.inICloud)) {
		const raw = (await readOptional(join(index.root, path)))!;
		const chapter = path.slice(BUOY_FOLDER.length + 1, -'.json'.length);
		const text = hasOpenMarks(raw) ? (await index.read(chapter)).text : '';
		const file = parseBuoyFile(raw, (state) => markAt(text, text.length - frontmatterLength(text), state, 'assistant', new Date()));
		if (!file) {
			throw new Error(`${zh.renameBuoy}: ${path}`);
		}
		records.push({ path, file });
	}
	return records;
}
function buoyWrites(records: { path: string; file: BuoyFile }[], renames: Rename[]) {
	return records.flatMap(({ path, file }) => {
		const target = movedPath(path, renames);
		const after = {
			...file,
			chapter: movedPath(file.chapter, renames),
			marks: file.marks.map((mark) => ({ ...mark, state: renameState(mark.state, renames) })),
		};
		return serializeBuoyFile(after) === serializeBuoyFile(file) ? [] : [{ path: target, text: serializeBuoyFile(after) }];
	});
}
const diskOperations = { link, unlink, rename, write: atomicWrite };
/** The caller has checked the plan before stopping services and entering the index save queue. */
export async function renameBook(index: BookIndex, plan: Rename[], disk = diskOperations): Promise<RenameResult> {
	const records = plan.length ? await readBuoys(index) : [];
	const completed: Rename[] = [],
		written: string[] = [],
		failures: string[] = [];
	let linked: Rename | undefined;
	const reason = (error: unknown) =>
		['ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '') ? zh.renameUnsupported : String(error);
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
	} catch (error) {
		failures.push(reason(error));
	}
	index.followRenames(completed);
	const writes = completed.length ? buoyWrites(records, completed) : [];
	try {
		for (const write of writes) {
			await disk.write(join(index.root, write.path), write.text);
			written.push(write.path);
		}
	} catch (error) {
		failures.push(reason(error));
	}
	return {
		renames: completed,
		...(failures.length
			? {
					error: zh.renamePartial(
						completed,
						plan.slice(completed.length),
						written,
						writes.slice(written.length).map((write) => write.path),
						linked,
						failures.join('\n'),
					),
				}
			: {}),
	};
}
