import { parseDocument } from 'yaml';
import { movedPath } from '../../shared/paths';
import { join, dirname, basename } from 'node:path';
import { readdir, readFile, readlink, mkdtemp, mkdir, rm, rename, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Rename } from '../../core/library';
import { nameProblem } from '../../core/book';
import { BUOY_FOLDER } from '../../core/buoy';
import { BookIndex } from '../book/indexer';
import { atomicWrite, readOptional } from '../book/files';
import { info, safePath, moveAtomic, runFile } from './disk';
import { findNode } from './structure';
import { zh } from '../../renderer/strings';
async function manifest(root: string, path = ''): Promise<string[]> {
	const full = join(root, path),
		stat = (await info(full))!;
	if (stat.isSymbolicLink()) {
		return [`${path}:link:${await readlink(full)}`];
	}
	if (stat.isDirectory()) {
		return [
			`${path}:dir:${stat.mode}`,
			...(await Promise.all((await readdir(full)).sort().map((name) => manifest(root, path ? `${path}/${name}` : name)))).flat(),
		];
	}
	if (!stat.isFile() || stat.nlink !== 1) {
		throw new Error(`${zh.renameUnsupported}: ${path}`);
	}
	return [
		`${path}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${createHash('sha256')
			.update(await readFile(full))
			.digest('hex')}`,
	];
}
async function jsonFiles(root: string, path: string): Promise<string[]> {
	if (!(await info(join(root, path)))) {
		return [];
	}
	const entries = await readdir(join(root, path), { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const file = `${path}/${entry.name}`;
				if (entry.isSymbolicLink()) {
					throw new Error(zh.renameLink);
				}
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
	if (name.trim() === node.name) {
		return [];
	}
	const plan = index.library.renames(node, name.trim());
	if (plan.blocked) {
		throw new Error(`${zh.renameShared}: ${plan.blocked.path}`);
	}
	const renames = [...plan.renames];
	const buoyFrom = `${BUOY_FOLDER}/${node.path}${node.kind === 'chapter' ? '.json' : ''}`;
	if (await info(join(index.root, buoyFrom))) {
		renames.push({ from: buoyFrom, to: `${BUOY_FOLDER}/${movedPath(node.path, renames)}${node.kind === 'chapter' ? '.json' : ''}` });
	}
	for (const move of renames) {
		const source = await safePath(index.root, move.from),
			target = await safePath(index.root, move.to);
		if (!(await info(source))) {
			throw new Error(`${zh.fileMissing}: ${move.from}`);
		}
		if (await info(target)) {
			throw new Error(`${zh.fileExists}: ${move.to}`);
		}
	}
	return renames;
}
/** All work is prepared on a same-volume clone; only the final exchange touches the original tree. */
export async function renameBook(
	index: BookIndex,
	path: string,
	name: string,
	exchange: (from: string, to: string) => Promise<void> = (from, to) => moveAtomic(from, to, true),
): Promise<Rename[]> {
	const root = await realpath(index.root);
	const before = JSON.stringify(await manifest(root));
	const current = new BookIndex(root, index.configuration);
	await current.load();
	const renames = await renamePlan(current, path, name);
	current.dispose();
	if (!renames.length) {
		return [];
	}
	const temporary = await mkdtemp(join(dirname(root), `.${basename(root)}-rename-`));
	const staged = join(temporary, 'book');
	try {
		// cp preserves metadata and uses APFS copy-on-write; unsupported volumes fail before the commit.
		await runFile('/bin/cp', ['-cRp', root, staged]);
		if (JSON.stringify(await manifest(staged)) !== before) {
			throw new Error(zh.renameChanged);
		}
		for (const { from, to } of renames) {
			await mkdir(dirname(join(staged, to)), { recursive: true });
			await rename(join(staged, from), join(staged, to));
		}
		for (const file of await jsonFiles(staged, BUOY_FOLDER)) {
			const raw = (await readOptional(join(staged, file)))!;
			if (parseDocument(raw).errors.length) {
				throw new Error(zh.renameBuoy);
			}
			const data = JSON.parse(raw);
			if (typeof data.chapter !== 'string' || !Array.isArray(data.marks)) {
				throw new Error(zh.renameBuoy);
			}
			data.chapter = movedPath(data.chapter, renames);
			for (const mark of data.marks) {
				if (!Array.isArray(mark.state?.nodes)) {
					throw new Error(zh.renameBuoy);
				}
				for (const node of mark.state.nodes) {
					if (typeof node.id !== 'string') {
						throw new Error(zh.renameBuoy);
					}
					const hash = node.id.indexOf('#');
					const filePath = hash === -1 ? node.id : node.id.slice(0, hash);
					node.id = movedPath(filePath, renames) + (hash === -1 ? '' : node.id.slice(hash));
				}
			}
			if (JSON.stringify(data) !== JSON.stringify(JSON.parse(raw))) {
				await atomicWrite(join(staged, file), JSON.stringify(data, null, 2) + '\n');
			}
		}
		if (JSON.stringify(await manifest(root)) !== before) {
			throw new Error(zh.renameChanged);
		}
		await exchange(staged, root);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return renames;
}
