import { ipcMain } from 'electron';
import { channels, type CompletionInput } from '../../shared/api';
import type { MainContext } from '../context';
export function registerCompletion(ctx: MainContext): void {
	ipcMain.handle(channels.completionRequest, (event, input: CompletionInput) => {
		const book = ctx.bookFor(event)!;
		return ctx.completion.request(String(event.sender.id), book, input);
	});
	ipcMain.on(channels.completionCancel, (event, id: number) => ctx.completion.cancel(String(event.sender.id), id));
}
