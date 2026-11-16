import { channels } from '../../shared/api';
import { ipcMain, shell } from 'electron';
import type { MainContext } from '../context';
import type { NamesLanguage } from '../../core/story';
import { zh } from '../../renderer/strings';
import type { StructureAction, StructureInput, TrashTarget } from '../../shared/structure';
import { initialization, initialize } from './initialize';
import { structureSuggestion, createStructure } from './structure';
import { renamePlan, renameBook } from './rename';
import { executeTrash, trashPlan } from './trash';
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
	ipcMain.handle(channels.structureTrashPlan, (event, target: TrashTarget) => trashPlan(ctx.bookFor(event)!, target));
	ipcMain.handle(channels.structureTrash, async (event, target: TrashTarget) => {
		const book = ctx.bookFor(event)!;
		if (ctx.isBookBusy(book.root)) {
			throw new Error(zh.trashBusy);
		}
		ctx.completion.cancel(String(event.sender.id));
		await ctx.completion.buoys(book).dispose();
		ctx.completion.closeBook(book.root);
		await ctx.completion.drain(String(event.sender.id));
		return ctx.snapshots.write(
			book.root,
			() => {
				if (ctx.isBookBusy(book.root)) {
					throw new Error(zh.trashBusy);
				}
				return book.exclusive(() => executeTrash(book, target, (fullPath) => shell.trashItem(fullPath)));
			},
			(result) => result.trashed.length > 0,
		);
	});
}
