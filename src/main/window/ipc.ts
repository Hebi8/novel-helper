import { ipcMain } from 'electron';
import { channels, type SessionState } from '../../shared/api';
import type { MainContext } from '../context';
export function registerWindow(ctx: MainContext): void {
	ipcMain.handle(channels.focusSet, (event, enabled: boolean) => {
		ctx.windowFor(event).setFullScreen(enabled);
	});
	ipcMain.on(channels.close, (event) => {
		ctx.windowFor(event).close();
	});
	ipcMain.handle(channels.bootstrap, (event) => {
		const index = ctx.bookFor(event);
		return {
			book: index?.book,
			openResult: ctx.initialResult(event),
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
