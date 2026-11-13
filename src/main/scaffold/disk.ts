import { dirname, join } from 'node:path';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { bookPath } from '../book/paths';
import { zh } from '../../renderer/strings';
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
	const full = await safePath(root, path);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
}
