import { inspectBook } from '../book/indexer';
import type { WindowStore } from './state';
import type { OpenResult } from '../../shared/api';
import { zh } from '../../renderer/strings';
export async function inspectRememberedBook(root: string, store: WindowStore) {
	try {
		return await inspectBook(root);
	} catch (error) {
		store.forget(root);
		const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
		return { roots: [], error: missing ? zh.missingBook : String(error) };
	}
}
export async function restoreBooks(store: WindowStore, open: (root: string) => Promise<OpenResult>): Promise<number> {
	let count = 0;
	for (const root of [...store.value.open]) {
		if ((await open(root)).kind === 'opened') {
			count++;
		} else {
			store.forget(root);
		}
	}
	return count;
}
