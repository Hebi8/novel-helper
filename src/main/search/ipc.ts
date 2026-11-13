import { ipcMain } from 'electron';
import { channels } from '../../shared/api';
import type { MainContext } from '../context';
import { searchBook } from './search';
export function registerSearch(ctx: MainContext): void {
	ipcMain.handle(channels.bookSearch, (event, query: string) => searchBook(ctx.bookFor(event)!.root, query));
}
