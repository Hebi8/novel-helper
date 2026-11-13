import { ipcMain,dialog } from 'electron';
import { channels } from '../../shared/api';
import type { MainContext } from '../context';
export function registerBook(ctx: MainContext): void {
  ipcMain.handle(channels.bookOpen,async (event,root?: string) => {
    const window=ctx.windowFor(event);
    const selected=root??(await dialog.showOpenDialog(window,{ properties: ['openDirectory'] })).filePaths[0];
    return selected? ctx.open(selected,window):{ kind: 'cancelled' };
  });
  ipcMain.handle(channels.bookRead,(event,path: string) => ctx.bookFor(event).read(path));
  ipcMain.handle(channels.bookSave,(event,path: string,text: string,base: string,force?: boolean) => ctx.bookFor(event).save(path,text,base,force));
}
