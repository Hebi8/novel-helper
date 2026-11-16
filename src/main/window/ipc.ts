import { ipcMain } from 'electron';
import { channels, type SessionState } from '../../shared/api';
import { isICloudDriveAvailable, listICloudBooks } from '../book/icloud';
import type { MainContext } from '../context';
export function registerWindow(ctx: MainContext): void {
	ipcMain.handle(channels.focusSet, (event, enabled: boolean) => {
		ctx.windowFor(event).setFullScreen(enabled);
	});
	ipcMain.on(channels.close, (event) => {
		ctx.windowFor(event).close();
	});
	ipcMain.handle(channels.bootstrap, async (event) => {
		const index = ctx.bookFor(event);
		const icloudAvailable = await isICloudDriveAvailable();
		return {
			book: index?.book,
			openResult: ctx.initialResult(event),
			notice: ctx.initialNotice(event),
			icloudAvailable,
			icloudBooks: !index && icloudAvailable ? await listICloudBooks() : [],
			recent: ctx.windows.value.recent,
			session: index ? ctx.windows.session(index.root) : { tabs: [] },
			settings: ctx.settings.get(),
			usage: ctx.completion.status(),
		};
	});
	ipcMain.handle(channels.session, (event, session: SessionState) => {
		const index = ctx.bookFor(event);
		if (index) {
			ctx.windows.setSession(index.root, session);
		}
	});
}
