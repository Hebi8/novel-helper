import { ipcMain } from 'electron';
import { channels, type SettingKey, type Settings } from '../../shared/api';
import type { MainContext } from '../context';
import { notifyAssistantSettingsChanged } from '../assistant/ipc';
export function registerSettings(ctx: MainContext): void {
	ipcMain.handle(channels.settingsGet, () => ctx.settings.get());
	ipcMain.handle(channels.settingsSet, async (_event, key: SettingKey, value: Settings[SettingKey]) => {
		ctx.settings.set(key, value);
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
}
