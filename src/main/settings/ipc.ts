import { app, ipcMain, nativeTheme, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { channels, type SettingKey, type Settings } from '../../shared/api';
import type { MainContext } from '../context';
import { notifyAssistantSettingsChanged } from '../assistant/ipc';
import { ICLOUD_BOOKS_FOLDER, icloudBooksRoot, isICloudDriveAvailable } from '../book/icloud';
import { bookWords } from '../book/words';

const appVersion = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string }).version;

export function registerSettings(ctx: MainContext): void {
	nativeTheme.themeSource = ctx.settings.get()['appearance.theme'];
	ipcMain.handle(channels.settingsGet, () => ctx.settings.get());
	ipcMain.handle(channels.settingsSet, async (_event, key: SettingKey, value: Settings[SettingKey]) => {
		ctx.settings.set(key, value);
		if (key === 'appearance.theme') {
			nativeTheme.themeSource = ctx.settings.get()['appearance.theme'];
		}
		if (key === 'editor.dayStartHour') {
			bookWords.publishAll(ctx);
		}
		if (key.startsWith('files.')) {
			await ctx.reindexBooks();
		}
		if (key === 'snapshots.intervalMinutes') {
			void ctx.snapshots.reconfigure();
		}
		if (key.startsWith('assistant.')) {
			notifyAssistantSettingsChanged();
		}
		ctx.completion.settingsChanged();
		ctx.broadcast(channels.settingsChanged, ctx.settings.get());
	});
	ipcMain.handle(channels.settingsOpen, () => ctx.openSettings());
	ipcMain.handle(channels.settingsInfo, async () => {
		const icloudAvailable = await isICloudDriveAvailable();
		return {
			appName: app.getName(),
			version: appVersion,
			icloudAvailable,
			icloudFolderName: ICLOUD_BOOKS_FOLDER,
			icloudBooksPath: icloudBooksRoot(),
		};
	});
	ipcMain.handle(channels.settingsRevealICloud, async () => {
		if (!(await isICloudDriveAvailable())) {
			return;
		}
		const booksRoot = icloudBooksRoot();
		await mkdir(booksRoot, { recursive: true });
		shell.showItemInFolder(booksRoot);
	});
}
