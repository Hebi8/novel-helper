import { ipcMain } from 'electron';
import { channels,type CompletionInput } from '../../shared/api';
import type { MainContext } from '../context';
export function registerCompletion(ctx: MainContext): void {
  ipcMain.handle(channels.completionRequest,(event,input: CompletionInput) => ctx.completion.request(String(event.sender.id),ctx.bookFor(event),input));
  ipcMain.on(channels.completionCancel,(event,id: number) => ctx.completion.cancel(String(event.sender.id),id));
}
