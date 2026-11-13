import { ipcMain } from 'electron';
import { channels, type SettingKey, type Settings } from '../../shared/api';
import type { MainContext } from '../context';
export function registerSettings(ctx: MainContext): void {
	ipcMain.handle(channels.settingsGet, () => ctx.settings.get());
	ipcMain.handle(channels.settingsSet, (_event, key: SettingKey, value: Settings[SettingKey]) => {
		ctx.settings.set(key, value);
		ctx.completion.settingsChanged();
		ctx.broadcast(channels.settingsChanged, ctx.settings.get());
	});
	ipcMain.handle(channels.settingsOpen, () => ctx.openSettings());
}
