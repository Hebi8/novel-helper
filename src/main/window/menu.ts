import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { channels, type MenuCommand } from '../../shared/api';
import { zh } from '../../renderer/strings';
import type { MainContext } from '../context';
export function installMenu(ctx: MainContext): void {
	const saving = ctx.isFocusedBookSavingToICloud();
	const action = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
		label,
		accelerator,
		enabled: !saving,
		click: () => (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send(channels.command, command),
	});
	const openRoot = async (root: string) => {
		const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
		const result = await ctx.open(root, window);
		if (result.kind !== 'opened') {
			if (window) {
				window.webContents.send(channels.openResult, result);
			} else {
				ctx.openWelcome(result);
			}
		}
	};
	const open = async () => {
		const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
		if (filePaths[0]) {
			await openRoot(filePaths[0]);
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
								void openRoot(root);
							},
						})),
					},
					...(ctx.canSaveFocusedBookToICloud() ? [action(zh.saveToICloud, 'saveToICloud')] : []),
					{ type: 'separator' },
					action(zh.newChapter, 'newChapter', 'Cmd+N'),
					action(zh.quickOpen, 'quickOpen', 'Cmd+P'),
					action(zh.closeTab, 'closeTab', 'Cmd+W'),
					action(zh.previousTab, 'previousTab', 'Cmd+Shift+['),
					action(zh.nextTab, 'nextTab', 'Cmd+Shift+]'),
				],
			},
			{
				label: zh.edit,
				submenu: [
					{ label: zh.undo, role: 'undo', enabled: !saving },
					{ label: zh.redo, role: 'redo', enabled: !saving },
					{ type: 'separator' },
					{ label: zh.cut, role: 'cut', enabled: !saving },
					{ label: zh.copy, role: 'copy' },
					{ label: zh.paste, role: 'paste', enabled: !saving },
					{ label: zh.selectAll, role: 'selectAll' },
					action(zh.find, 'find', 'Cmd+F'),
					action(zh.searchBook, 'searchBook', 'Cmd+Shift+F'),
				],
			},
			{
				label: zh.view,
				submenu: [
					action(zh.split, 'split', 'Cmd+\\'),
					action(zh.focus, 'focus', 'Ctrl+Cmd+F'),
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
					action(zh.report, 'report'),
					action(zh.usageReport, 'usageReport'),
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
				label: zh.assistant,
				submenu: [
					action(zh.assistantFocus, 'assistant:focus', 'Cmd+L'),
					action(zh.assistantStop, 'assistant:stop', 'Cmd+.'),
					action(zh.assistantHistory, 'assistant:history'),
				],
			},
			{
				label: zh.help,
				submenu: [
					{
						label: zh.openLogs,
						click: () => {
							const logs = app.getPath('logs');
							shell.showItemInFolder(logs);
						},
					},
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
