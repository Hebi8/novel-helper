import { zh } from '../../renderer/strings';
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MainContext } from '../context';
import { channels as c } from '../../shared/api';
import type { EditorContext } from '../../core/assistantBrief';
import { AssistantService } from './service';
import { bookNames } from '../book/names';
import { prepareAgentEnvironment } from './environment';
import { assistantReverted, assistantTurnEnded } from './events';
import { AssistantRegistry } from './registry';

const services = new AssistantRegistry();
export function isAssistantBusy(root: string): Promise<boolean> {
	return services.busy(root);
}
export async function prepareBookRename(root: string): Promise<void> {
	if (await services.busy(root)) {
		throw new Error(zh.renameBusy);
	}
}
export function notifyAssistantSettingsChanged(): void {
	void services.each((service) => service.refreshOptions());
}
export function registerAssistant(ctx: MainContext): void {
	const userData = app.getPath('userData');
	const closingBooks = new Set<Promise<void>>();
	void prepareAgentEnvironment().catch((error: Error) =>
		appendFileSync(join(app.getPath('logs'), 'assistant-startup.log'), `${error.message}\n`),
	);
	const service = (event: IpcMainInvokeEvent): Promise<AssistantService> => {
		const book = ctx.bookFor(event)!;
		return services.get(book.root, async () => {
			const assistant = new AssistantService({
				root: book.root,
				userData,
				settings: () => ctx.settings.get(),
				store: ctx.snapshots.store(book.root),
				beforeHistory: () => ctx.snapshots.flush(book.root),
				assistantOptions: (agent) => ctx.settings.assistantOptions(agent),
				setAssistantOptions: (agent, value) => ctx.settings.setAssistantOptions(agent, value),
				names: async () => bookNames(book),
			});
			await assistant.load();
			assistant.onChanged((state) => {
				if (!event.sender.isDestroyed()) {
					event.sender.send(c.assistantChanged, state);
				}
			});
			assistant.onTurnEnded((changes) => assistantTurnEnded({ root: book.root, changes }));
			assistant.onReverted((changes) => assistantReverted({ root: book.root, changes }));
			return assistant;
		});
	};
	ctx.onBookClosed((root) => {
		const task = (async () => {
			const busy = await services.busy(root);
			await services.close(root);
			if (busy) {
				await ctx.snapshots.discard(root);
			} else {
				await ctx.snapshots.close(root);
			}
		})().finally(() => {
			closingBooks.delete(task);
		});
		closingBooks.add(task);
		return task;
	});
	let drained = false;
	app.on('will-quit', (event) => {
		if (drained) {
			return;
		}
		event.preventDefault();
		void Promise.all([...closingBooks, services.closeAll(), ctx.snapshots.drain()]).finally(() => {
			drained = true;
			// With nothing left to close this settles while the first quit is still unwinding, and a quit requested then is dropped.
			setImmediate(() => app.quit());
		});
	});
	ipcMain.handle(c.assistantState, async (event) => (await service(event)).state());
	ipcMain.handle(c.assistantSend, async (event, text: string, context?: Partial<EditorContext>) =>
		(await service(event)).send(text, context),
	);
	ipcMain.handle(c.assistantSetOption, async (event, id: string, value: string) => {
		const changed = await (await service(event)).setOption(id, value);
		if (changed) {
			notifyAssistantSettingsChanged();
		}
		return changed;
	});
	ipcMain.handle(c.assistantStop, async (event) => (await service(event)).stop());
	ipcMain.handle(c.assistantNewSession, async (event) => (await service(event)).newSession());
	ipcMain.handle(c.assistantAnswer, async (event, id: string, allow: boolean) => (await service(event)).answer(id, allow));
	ipcMain.handle(c.assistantHistory, async (event) => (await service(event)).history());
	ipcMain.handle(c.assistantDiff, async (event, id: number, path: string) => (await service(event)).diff(id, path));
	ipcMain.handle(c.assistantRevert, async (event, id: number) => (await service(event)).revert(id));
	ipcMain.handle(c.assistantLink, async (_event, href: string) => {
		if (/^(https?:\/\/|mailto:)/i.test(href)) {
			await shell.openExternal(href);
		}
	});
}
