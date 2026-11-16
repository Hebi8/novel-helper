import { info, safePath } from '../scaffold/disk';
import { atomicWrite, readDocument } from './files';
import { bookPath } from './paths';
import { ipcMain, dialog, shell } from 'electron';
import { channels, type ConflictResolution } from '../../shared/api';
import { zh } from '../../renderer/strings';
import type { MainContext } from '../context';
export function registerBook(ctx: MainContext): void {
	ipcMain.handle(channels.bookReveal, async (event, path: string) => {
		const book = ctx.bookFor(event)!;
		shell.showItemInFolder(path ? await safePath(book.root, path) : book.root);
	});
	ipcMain.handle(channels.bookOpen, async (event, root?: string, chosen = false) => {
		const window = ctx.windowFor(event);
		const selected = root ?? (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0];
		return selected ? ctx.open(selected, window, chosen) : { kind: 'cancelled' };
	});
	ipcMain.handle(channels.bookRead, (event, path: string) => ctx.bookFor(event)!.read(bookPath(path)));
	ipcMain.handle(channels.bookSave, (event, path: string, text: string, base: string, force?: boolean) => {
		const book = ctx.bookFor(event)!;
		return ctx.snapshots.write(
			book.root,
			() => book.save(bookPath(path), text, base, force),
			(result) => result.saved,
		);
	});
	ipcMain.handle(channels.bookConflictDiff, async (event, path: string) => {
		const book = ctx.bookFor(event)!;
		const copy = bookPath(path);
		const original = book.conflictOriginalOf(copy);
		if (!original) {
			throw new Error(zh.fileMissing);
		}
		const [origFull, copyFull] = await Promise.all([safePath(book.root, original), safePath(book.root, copy)]);
		const [before, after] = await Promise.all([readDocument(origFull), readDocument(copyFull)]);
		if (!before || !after) {
			throw new Error(zh.fileMissing);
		}
		return { path: copy, original, before: before.text, after: after.text };
	});
	ipcMain.handle(channels.bookConflictResolve, async (event, path: string, action: ConflictResolution) => {
		const book = ctx.bookFor(event)!;
		const copy = bookPath(path);
		const original = book.conflictOriginalOf(copy);
		if (!original) {
			throw new Error(zh.fileMissing);
		}
		await ctx.snapshots.beforeWrite(book.root, async () => {
			if (action === 'trash') {
				const copyFull = await safePath(book.root, copy);
				if (!(await info(copyFull))) {
					throw new Error(zh.fileMissing);
				}
				await shell.trashItem(copyFull);
				await book.refresh(copy);
				return;
			}
			const [origFull, copyFull] = await Promise.all([safePath(book.root, original), safePath(book.root, copy)]);
			const [before, after] = await Promise.all([readDocument(origFull), readDocument(copyFull)]);
			if (!before || !after) {
				throw new Error(zh.fileMissing);
			}
			const store = ctx.snapshots.store(book.root);
			const record = await store.begin({ kind: 'conflict', title: original });
			try {
				await atomicWrite(origFull, after.text.replaceAll('\n', after.lineEnding));
				await shell.trashItem(copyFull);
			} finally {
				await store.finish(record.id);
			}
			await book.refresh(copy);
			await book.refresh(original);
		});
	});
}
