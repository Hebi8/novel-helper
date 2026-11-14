import { channels } from '../../shared/api';
import { ipcMain } from 'electron';
import type { MainContext } from '../context';
import type { NamesLanguage } from '../../core/story';
import type { StructureAction, StructureInput } from '../../shared/structure';
import { initialization, initialize } from './initialize';
import { structureSuggestion, createStructure } from './structure';
import { renamePlan, renameBook } from './rename';
export function registerScaffold(ctx: MainContext): void {
	ipcMain.handle(
		channels.structurePlan,
		async (_event, root: string, language: NamesLanguage) => (await initialization(root, language, ctx.settings.get())).items,
	);
	ipcMain.handle(channels.structureInitialize, async (event, root: string, language: NamesLanguage, selected: string[]) => {
		await initialize(root, language, selected, ctx.settings.get());
		return ctx.open(root, ctx.windowFor(event));
	});
	ipcMain.handle(channels.structureSuggest, (event, action: StructureAction, path?: string) =>
		structureSuggestion(ctx.bookFor(event)!, action, path),
	);
	ipcMain.handle(channels.structureCreate, async (event, input: StructureInput) => {
		const book = ctx.bookFor(event)!;
		if (input.action !== 'rename') {
			const created = { path: await createStructure(book, input) };
			await ctx.snapshots.afterSave(book.root);
			return created;
		}
		const plan = await renamePlan(book, input.path!, input.name);
		if (!plan.length) {
			return { renames: [] };
		}
		await ctx.prepareBookRename(book.root);
		ctx.completion.cancel(String(event.sender.id));
		const buoys = ctx.completion.buoys(book);
		await buoys.dispose();
		ctx.completion.closeBook(book.root);
		await ctx.completion.drain(String(event.sender.id));
		const renamed = await book.exclusive(() => renameBook(book, plan));
		await ctx.snapshots.afterSave(book.root);
		return renamed;
	});
}
