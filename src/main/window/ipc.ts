import { dialog, ipcMain } from 'electron';
import { channels, type SessionState } from '../../shared/api';
import { isICloudDriveAvailable, listICloudBooks } from '../book/icloud';
import { bookEntries } from '../book/indexer';
import { bookWords } from '../book/words';
import type { MainContext } from '../context';
export function registerWindow(ctx: MainContext): void {
	ipcMain.handle(channels.focusSet, (event, enabled: boolean) => {
		ctx.setFocusMode(event, enabled);
	});
	ipcMain.on(channels.close, (event) => {
		ctx.closeView(event);
	});
	ipcMain.handle(channels.bootstrap, async (event) => {
		ctx.markBootstrapped(event);
		const index = ctx.bookFor(event);
		const icloudAvailable = await isICloudDriveAvailable();
		const words = index ? bookWords.ensure(index, ctx) : { todayWords: 0, chapterWords: {} };
		return {
			book: index?.book,
			openResult: ctx.initialResult(event),
			notice: ctx.initialNotice(event),
			icloudAvailable,
			icloudBooks: !index && icloudAvailable ? await bookEntries(await listICloudBooks()) : [],
			recent: await bookEntries(ctx.windows.value.recent),
			session: index ? ctx.windows.session(index.root) : { tabs: [] },
			settings: ctx.settings.get(),
			usage: ctx.completion.status(),
			words,
		};
	});
	ipcMain.handle(channels.session, (event, session: SessionState) => {
		const index = ctx.bookFor(event);
		if (index) {
			ctx.windows.setSession(index.root, session);
		}
	});
	ipcMain.handle(channels.tabsState, () => ctx.tabBarState());
	ipcMain.handle(channels.tabsSelect, (_event, id: number) => {
		ctx.selectTab(id);
	});
	ipcMain.handle(channels.tabsSelectIndex, (_event, index: number) => {
		ctx.selectTabIndex(index);
	});
	ipcMain.handle(channels.tabsCycle, (_event, step: number) => {
		ctx.cycleTab(step);
	});
	ipcMain.handle(channels.tabsClose, (event, id?: number) => ctx.closeTab(id, event.sender));
	ipcMain.handle(channels.tabsOpenMenu, async () => {
		const icloudAvailable = await isICloudDriveAvailable();
		const [icloudBooks, recent] = await Promise.all([
			icloudAvailable ? bookEntries(await listICloudBooks()) : Promise.resolve([]),
			bookEntries(ctx.windows.value.recent),
		]);
		ctx.setTabMenuExpanded(true);
		return { icloudBooks, recent };
	});
	ipcMain.handle(channels.tabsCloseMenu, () => {
		ctx.setTabMenuExpanded(false);
	});
	ipcMain.handle(channels.tabsOpenBook, async (_event, root?: string) => {
		ctx.setTabMenuExpanded(false);
		const parent = ctx.mainWindow();
		const selected =
			root ??
			(parent
				? await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
				: await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
			).filePaths[0];
		if (!selected) {
			return;
		}
		const target = ctx.activeSender();
		const result = await ctx.open(selected, target);
		if (result.kind !== 'opened') {
			ctx.sendOpenResult(result, target);
		}
	});
}
