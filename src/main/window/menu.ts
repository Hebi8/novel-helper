import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { channels, type MenuCommand } from '../../shared/api';
import { zh } from '../../renderer/strings';
import type { MainContext } from '../context';
export function installMenu(ctx: MainContext): void {
	const action = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
		label,
		accelerator,
		click: () => BrowserWindow.getFocusedWindow()?.webContents.send(channels.command, command),
	});
	const open = async () => {
		const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
		if (filePaths[0]) {
			const window = BrowserWindow.getFocusedWindow();
			const result = await ctx.open(filePaths[0], window ?? undefined);
			if (result.kind !== 'opened' && window) {
				window.webContents.send(channels.openResult, result);
			}
		}
	};
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: zh.app,
				submenu: [
					{ label: zh.about, role: 'about' },
					{ type: 'separator' },
					{ label: zh.settings, accelerator: 'Cmd+,', click: () => ctx.openSettings() },
					{ type: 'separator' },
					{ label: zh.quit, click: () => app.quit(), accelerator: 'Cmd+Q' },
				],
			},
			{
				label: zh.file,
				submenu: [
					{ label: zh.open, accelerator: 'Cmd+O', click: open },
					{
						label: zh.recent,
						submenu: ctx.windows.value.recent.map((root) => ({
							label: root,
							click: () => {
								void ctx.open(root).then((result) => {
									if (result.kind === 'error') {
										const window = BrowserWindow.getFocusedWindow();
										if (window) {
											window.webContents.send(channels.openResult, result);
										} else {
											void dialog.showMessageBox({ message: result.message });
										}
									}
								});
							},
						})),
					},
					{ type: 'separator' },
					action(zh.closeTab, 'closeTab', 'Cmd+W'),
					action(zh.previousTab, 'previousTab', 'Cmd+Shift+['),
					action(zh.nextTab, 'nextTab', 'Cmd+Shift+]'),
				],
			},
			{
				label: zh.edit,
				submenu: [
					{ label: zh.undo, role: 'undo' },
					{ label: zh.redo, role: 'redo' },
					{ type: 'separator' },
					{ label: zh.cut, role: 'cut' },
					{ label: zh.copy, role: 'copy' },
					{ label: zh.paste, role: 'paste' },
					{ label: zh.selectAll, role: 'selectAll' },
					action(zh.find, 'find', 'Cmd+F'),
				],
			},
			{
				label: zh.view,
				submenu: [
					action(zh.left, 'left:toggle', 'Cmd+0'),
					action(zh.right, 'right:toggle', 'Alt+Cmd+0'),
					action(zh.chapters, 'left:0', 'Cmd+1'),
					action(zh.outline, 'left:1', 'Cmd+2'),
					action(zh.lore, 'left:2', 'Cmd+3'),
					action(zh.readOutline, 'right:0', 'Alt+Cmd+1'),
					action(zh.readLore, 'right:1', 'Alt+Cmd+2'),
					action(zh.assistant, 'right:2', 'Alt+Cmd+3'),
				],
			},
			{
				label: zh.continuation,
				submenu: [
					{
						label: zh.toggle,
						click: () => {
							ctx.settings.set('enabled', !ctx.settings.get().enabled);
							ctx.completion.settingsChanged();
							ctx.broadcast(channels.settingsChanged, ctx.settings.get());
						},
					},
					action(zh.ask, 'manual', 'Alt+\\'),
				],
			},
			{
				label: zh.window,
				submenu: [
					{ label: zh.minimize, role: 'minimize' },
					{ label: zh.zoom, role: 'zoom' },
				],
			},
			{
				label: zh.help,
				submenu: [
					{
						label: zh.helpTitle,
						click: () => {
							void dialog.showMessageBox({ title: zh.app, message: zh.app, detail: zh.helpText });
						},
					},
				],
			},
		]),
	);
}
