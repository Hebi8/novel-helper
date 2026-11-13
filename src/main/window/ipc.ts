import { ipcMain } from 'electron';
import { channels,type SessionState } from '../../shared/api';
import type { MainContext } from '../context';
export function registerWindow(ctx: MainContext): void {
  ipcMain.handle(channels.bootstrap,event => {
    const index=ctx.bookFor(event);
    return { book: index?.book,recent: ctx.windows.value.recent,session: index? ctx.windows.session(index.root):{ tabs: [] },settings: ctx.settings.get(),usage: ctx.completion.status() };
  });
  ipcMain.handle(channels.session,(event,session: SessionState) => { const index=ctx.bookFor(event); if(index) { ctx.windows.setSession(index.root,session); } });
}
