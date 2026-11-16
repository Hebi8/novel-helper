import type { BookSnapshots } from '../assistant/snapshots';
import { safePath } from '../scaffold/disk';
import type { ConflictDiff, ConflictResolveInput, ConflictResolveResult } from '../../shared/api';
import { zh } from '../../renderer/strings';
import { atomicWrite, readVersionedDocument } from './files';
import type { BookIndex } from './indexer';
import { bookPath } from './paths';

export async function readConflictDiff(book: BookIndex, rawPath: string): Promise<ConflictDiff> {
	const copy = bookPath(rawPath);
	const original = book.conflictOriginalOf(copy);
	if (!original) {
		throw new Error(zh.fileMissing);
	}
	const [origFull, copyFull] = await Promise.all([safePath(book.root, original), safePath(book.root, copy)]);
	const [before, after] = await Promise.all([readVersionedDocument(origFull), readVersionedDocument(copyFull)]);
	if (!before || !after) {
		throw new Error(zh.fileMissing);
	}
	return {
		path: copy,
		original,
		before: before.text,
		after: after.text,
		beforeHash: before.hash,
		afterHash: after.hash,
	};
}

export async function resolveConflictCopy(
	book: BookIndex,
	snapshots: BookSnapshots,
	input: ConflictResolveInput,
	trashItem: (fullPath: string) => Promise<void>,
): Promise<ConflictResolveResult> {
	const copy = bookPath(input.path);
	const original = book.conflictOriginalOf(copy);
	if (!original) {
		throw new Error(zh.fileMissing);
	}
	return snapshots.beforeWrite(book.root, async () => {
		if (input.action === 'trash') {
			const copyFull = await safePath(book.root, copy);
			const after = await readVersionedDocument(copyFull);
			if (!after) {
				throw new Error(zh.fileMissing);
			}
			if (after.hash !== input.afterHash) {
				return { ok: false, reason: 'changed', message: zh.conflictChanged };
			}
			await trashItem(copyFull);
			await book.refresh(copy);
			return { ok: true };
		}
		const [origFull, copyFull] = await Promise.all([safePath(book.root, original), safePath(book.root, copy)]);
		const [before, after] = await Promise.all([readVersionedDocument(origFull), readVersionedDocument(copyFull)]);
		if (!before || !after) {
			throw new Error(zh.fileMissing);
		}
		if (before.hash !== input.beforeHash || after.hash !== input.afterHash) {
			return { ok: false, reason: 'changed', message: zh.conflictChanged };
		}
		const store = snapshots.store(book.root);
		const record = await store.begin({ kind: 'conflict', title: original });
		let replaced = false;
		try {
			const current = await readVersionedDocument(origFull);
			if (!current) {
				throw new Error(zh.fileMissing);
			}
			if (current.hash !== input.beforeHash) {
				return { ok: false, reason: 'changed', message: zh.conflictChanged };
			}
			if (record.files[original] !== input.beforeHash) {
				return { ok: false, reason: 'unbacked', message: zh.conflictUnbacked };
			}
			replaced = true;
			await atomicWrite(origFull, after.text.replaceAll('\n', after.lineEnding));
			await trashItem(copyFull);
		} finally {
			if (replaced) {
				await store.finish(record.id);
			} else {
				await store.discard(record.id);
			}
		}
		await book.refresh(copy);
		await book.refresh(original);
		return { ok: true };
	});
}
