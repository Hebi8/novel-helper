import { safePath } from '../scaffold/disk';
import { readConflictDiff, resolveConflictCopy } from './conflicts';
import { currentICloudRoot } from './files';
import { copyBookToICloud, listICloudBooks, watchICloudBooks } from './icloud';
import { bookEntries } from './indexer';
import { bookPath } from './paths';
import { ipcMain, dialog, shell } from 'electron';
import { channels, type ConflictResolveInput } from '../../shared/api';
import { zh } from '../../renderer/strings';
import type { MainContext } from '../context';
export function registerBook(ctx: MainContext): void {
	const icloudWatchers = new Map<number, () => void>();
	const stopWatching = (id: number) => {
		icloudWatchers.get(id)?.();
		icloudWatchers.delete(id);
	};
	ipcMain.handle(channels.icloudWatch, async (event) => {
		const id = event.sender.id;
		stopWatching(id);
		const onDestroyed = () => stopWatching(id);
		const stop = watchICloudBooks(currentICloudRoot(), (books) => {
			void bookEntries(books).then((entries) => {
				if (!event.sender.isDestroyed()) {
					event.sender.send(channels.icloudChanged, entries);
				}
			});
		});
		event.sender.once('destroyed', onDestroyed);
		icloudWatchers.set(id, () => {
			event.sender.removeListener('destroyed', onDestroyed);
			stop();
		});
		return bookEntries(await listICloudBooks());
	});
	ipcMain.on(channels.icloudUnwatch, (event) => {
		stopWatching(event.sender.id);
	});
	ipcMain.handle(channels.bookSaveToICloud, async (event) => {
		const senderId = event.sender.id;
		if (ctx.isSavingToICloud(senderId)) {
			return;
		}
		const book = ctx.bookFor(event)!;
		ctx.setSavingToICloud(senderId, 'copying');
		try {
			if (ctx.isBookBusy(book.root)) {
				throw new Error(zh.saveToICloudBusy);
			}
			ctx.completion.cancel(String(senderId));
			await ctx.completion.buoys(book).dispose();
			ctx.completion.closeBook(book.root);
			await ctx.completion.drain(String(senderId));
			const targetDir = await ctx.snapshots.beforeWrite(book.root, async () => {
				if (ctx.isBookBusy(book.root)) {
					throw new Error(zh.saveToICloudBusy);
				}
				return copyBookToICloud(book.root, { trashItem: (fullPath) => shell.trashItem(fullPath) });
			});
			const opened = await ctx.open(targetDir, undefined, true, {
				notice: zh.savedToICloud(book.root),
				replaceRecent: book.root,
			});
			if (opened.kind !== 'opened') {
				throw new Error(opened.kind === 'error' ? opened.message : zh.missingBook);
			}
			ctx.setSavingToICloud(senderId, 'closing');
		} catch (error) {
			ctx.setSavingToICloud(senderId, undefined);
			throw error;
		}
	});
	ipcMain.handle(channels.bookReveal, async (event, path: string) => {
		const book = ctx.bookFor(event)!;
		shell.showItemInFolder(path ? await safePath(book.root, path) : book.root);
	});
	ipcMain.handle(channels.bookRenameTitle, (event, title: string) => {
		const book = ctx.bookFor(event)!;
		return ctx.snapshots.write(book.root, () => book.setTitle(title));
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
	ipcMain.handle(channels.bookConflictDiff, (event, path: string) => readConflictDiff(ctx.bookFor(event)!, path));
	ipcMain.handle(channels.bookConflictResolve, (event, input: ConflictResolveInput) =>
		resolveConflictCopy(ctx.bookFor(event)!, ctx.snapshots, input, (fullPath) => shell.trashItem(fullPath)),
	);
}
