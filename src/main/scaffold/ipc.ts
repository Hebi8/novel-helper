import { ipcMain, shell } from 'electron';
import type { MainContext } from '../context';
import type { NamesLanguage } from '../../core/story';
import type { StructureAction, StructureInput } from '../../shared/finish';
import { initialization, initialize } from './initialize';
import { structureSuggestion, createStructure } from './structure';
import { renameBook } from './rename';
import { searchBook } from '../search/search';
import { safePath } from './disk';
import { changeBook } from './activity';
export function registerScaffold(ctx: MainContext): void {
	ipcMain.handle(
		'finish:plan',
		async (_event, root: string, language: NamesLanguage) => (await initialization(root, language, ctx.settings.get())).items,
	);
	ipcMain.handle('finish:initialize', async (event, root: string, language: NamesLanguage, selected: string[]) => {
		await initialize(root, language, selected, ctx.settings.get());
		return ctx.open(root, ctx.windowFor(event));
	});
	ipcMain.handle('finish:suggest', (event, action: StructureAction, path?: string) =>
		structureSuggestion(ctx.bookFor(event)!, action, path, ctx.settings.get()),
	);
	ipcMain.handle('finish:create', async (event, input: StructureInput) => {
		const book = ctx.bookFor(event)!;
		if (input.action !== 'rename') {
			return { path: await createStructure(book, input, ctx.settings.get()) };
		}
		return changeBook(book.root, async () => {
			await ctx.prepareBookRename?.(book.root);
			ctx.completion.cancel(String(event.sender.id));
			const buoys = ctx.completion.buoys(book);
			buoys.dispose();
			await buoys.drain();
			ctx.completion.closeBook(book.root);
			await ctx.completion.drain(String(event.sender.id));
			return { renames: await book.exclusive(() => renameBook(book, input.path!, input.name)) };
		});
	});
	ipcMain.handle('finish:reveal', async (event, path: string) => {
		const book = ctx.bookFor(event)!;
		shell.showItemInFolder(path ? await safePath(book.root, path) : book.root);
	});
	ipcMain.handle('finish:search', (event, query: string) => searchBook(ctx.bookFor(event)!.root, query));
	ipcMain.handle('finish:focus', (event, enabled: boolean) => {
		const window = ctx.windowFor(event);
		window.setFullScreen(enabled);
		window.setMenuBarVisibility(!enabled);
	});
}
