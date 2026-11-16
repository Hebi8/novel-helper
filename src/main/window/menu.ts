import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { channels, type MenuCommand } from '../../shared/api';
import { zh } from '../../renderer/strings';
import type { MainContext } from '../context';
export function installMenu(ctx: MainContext): void {
	const saving = ctx.isMainWindowLocked() || ctx.isFocusedBookSavingToICloud() || ctx.isFocusedBookTrashing();
	const bookTabs = ctx.bookTabs();
	const action = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
		label,
		accelerator,
		enabled: !saving,
		click: () => ctx.sendCommand(command),
	});
	const openRoot = async (root: string) => {
		if (ctx.isMainWindowLocked()) {
			return;
		}
		const target = ctx.activeSender();
		const result = await ctx.open(root, target);
		if (result.kind !== 'opened' && result.kind !== 'cancelled') {
			ctx.sendOpenResult(result, target);
		}
	};
	const open = async () => {
		if (ctx.isMainWindowLocked()) {
			return;
		}
		const parent = ctx.mainWindow();
		const { filePaths } = parent
			? await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
			: await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
		if (filePaths[0] && !ctx.isMainWindowLocked()) {
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
					{ label: zh.open, accelerator: 'Cmd+O', enabled: !saving, click: open },
					{
						label: zh.recent,
						enabled: !saving,
						submenu: ctx.windows.value.recent.map((root) => ({
							label: root,
							enabled: !saving,
							click: () => {
								void openRoot(root);
							},
						})),
					},
					...(ctx.canSaveFocusedBookToICloud() ? [action(zh.saveToICloud, 'saveToICloud')] : []),
					{
						label: zh.renameBook,
						enabled: ctx.hasFocusedBook() && !saving,
						click: () => ctx.sendCommand('renameBook'),
					},
					{ type: 'separator' },
					action(zh.newChapter, 'newChapter', 'Cmd+N'),
					action(zh.quickOpen, 'quickOpen', 'Cmd+P'),
					{
						label: zh.closeBookTab,
						accelerator: 'Cmd+W',
						enabled: !saving,
						click: () => {
							void ctx.closeTab();
						},
					},
					action(zh.closeEditorTab, 'closeTab'),
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
					action(zh.chapters, 'left:0'),
					action(zh.outline, 'left:1'),
					action(zh.lore, 'left:2'),
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
					...(bookTabs.length
						? ([
								{ type: 'separator' },
								{
									label: zh.previousBookTab,
									accelerator: 'Ctrl+Shift+Tab',
									enabled: !saving && bookTabs.length > 1,
									click: () => ctx.cycleTab(-1),
								},
								{
									label: zh.nextBookTab,
									accelerator: 'Ctrl+Tab',
									enabled: !saving && bookTabs.length > 1,
									click: () => ctx.cycleTab(1),
								},
								{ type: 'separator' },
								...bookTabs.map((tab, index) => ({
									label: tab.title,
									type: 'checkbox' as const,
									checked: tab.active,
									enabled: !saving,
									accelerator: index < 9 ? `Cmd+${index + 1}` : undefined,
									click: () => ctx.selectTab(tab.id),
								})),
							] satisfies MenuItemConstructorOptions[])
						: []),
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
							const parent = BrowserWindow.getFocusedWindow() ?? ctx.mainWindow();
							if (parent) {
								void dialog.showMessageBox(parent, { title: zh.app, message: zh.app, detail: zh.helpText });
							} else {
								void dialog.showMessageBox({ title: zh.app, message: zh.app, detail: zh.helpText });
							}
						},
					},
				],
			},
		]),
	);
}
