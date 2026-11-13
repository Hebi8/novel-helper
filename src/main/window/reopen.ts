import { realpath } from 'node:fs/promises';
import type { WindowStore } from './state';
import type { OpenResult } from '../../shared/api';
import { zh } from '../../renderer/strings';
export async function resolveBookRoot(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch (error) {
		if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
			throw new Error(zh.missingBook);
		}
		throw error;
	}
}
export async function restoreBooks(store: WindowStore, open: (root: string) => Promise<OpenResult>): Promise<number> {
	let count = 0;
	for (const root of [...store.value.open]) {
		if ((await open(root)).kind === 'opened') {
			count++;
		} else {
			store.value.open = store.value.open.filter((path) => path !== root);
			store.save();
		}
	}
	return count;
}
