import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MainContext } from '../context';
import { channels as c } from '../../shared/api';
import type { EditorContext } from '../../core/assistantBrief';
import { AssistantService } from './service';
import { storyNames } from './names';
import { prepareAgentEnvironment } from './environment';
import { assistantReverted, assistantTurnEnded } from './events';
import { AssistantRegistry } from './registry';

export function registerAssistant(ctx: MainContext): void {
	const userData = app.getPath('userData');
	void prepareAgentEnvironment().catch((error: Error) => appendFileSync(join(userData, 'assistant-startup.log'), `${error.message}\n`));
	const services = new AssistantRegistry();
	const service = (event: IpcMainInvokeEvent): Promise<AssistantService> => {
		const book = ctx.bookFor(event)!;
		return services.get(book.root, async () => {
			const assistant = new AssistantService({
				root: book.root,
				userData,
				settings: () => ctx.settings.get(),
				names: () => storyNames(book),
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
	ctx.onBookClosed((root) => services.close(root));
	let drained = false;
	app.on('will-quit', (event) => {
		if (drained) {
			return;
		}
		event.preventDefault();
		void services.closeAll().finally(() => {
			drained = true;
			// With nothing left to close this settles while the first quit is still unwinding, and a quit requested then is dropped.
			setImmediate(() => app.quit());
		});
	});
	ipcMain.handle(c.assistantState, async (event) => (await service(event)).state());
	ipcMain.handle(c.assistantSend, async (event, text: string, context?: Partial<EditorContext>) =>
		(await service(event)).send(text, context),
	);
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
