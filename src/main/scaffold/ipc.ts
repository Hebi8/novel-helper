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
			return ctx.snapshots.write(book.root, async () => ({ path: await createStructure(book, input) }));
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
		return ctx.snapshots.write(book.root, () => book.exclusive(() => renameBook(book, plan)));
	});
}
