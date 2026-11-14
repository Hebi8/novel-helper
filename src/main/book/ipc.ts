import { safePath } from '../scaffold/disk';
import { bookPath } from './paths';
import { ipcMain, dialog, shell } from 'electron';
import { channels } from '../../shared/api';
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
}
