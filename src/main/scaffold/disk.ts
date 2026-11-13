import type {} from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { bookPath } from '../book/paths';
import { zh } from '../../renderer/strings';
export const runFile = promisify(execFile);
export const nativeHelper = () => (process.resourcesPath ? join(process.resourcesPath, 'book-fs') : resolve('dist/native/book-fs'));
// Development Electron has a resourcesPath too; the bundle lives next to dist/main.
export async function moveAtomic(from: string, to: string, swap = false): Promise<void> {
	const packaged = process.resourcesPath && !process.defaultApp;
	await runFile(packaged ? nativeHelper() : resolve('dist/native/book-fs'), [swap ? 'swap' : 'create', from, to]);
}
export async function info(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}
export async function safePath(root: string, path: string): Promise<string> {
	bookPath(path);
	let current = root;
	for (const part of path.split('/').filter(Boolean)) {
		current = join(current, part);
		if ((await info(current))?.isSymbolicLink()) {
			throw new Error(zh.renameLink);
		}
	}
	return current;
}
export async function createFile(root: string, path: string, content: string): Promise<void> {
	const full = await safePath(await realpath(root), path);
	if (await info(full)) {
		throw new Error(`${zh.fileExists}: ${path}`);
	}
	await mkdir(dirname(full), { recursive: true });
	const temporary = `${full}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
		await moveAtomic(temporary, full);
	} finally {
		await rm(temporary, { force: true });
	}
}
