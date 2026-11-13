import { prepareBookRename } from './assistant/ipc';
import { prepareOpen } from './scaffold/initialize';
import { resolveBookRoot, restoreBooks } from './window/reopen';
import { CloseGate } from './window/closeGate';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { join } from 'node:path';
import { SettingsStore } from './settings/store';
import { SecretStore } from './secrets/store';
import { UsageStore } from '../storage/usageStore';
import { CompletionService } from './completion/service';
import { WindowStore } from './window/state';
import { type BookIndex } from './book/indexer';
import { registerFeatures } from './register';
import { installMenu } from './window/menu';
import { channels, type OpenResult } from '../shared/api';
import type { MainContext } from './context';
const testing = process.argv.includes('--test-mode');
const userData = process.argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
if (userData) {
	app.setPath('userData', userData);
}
app.setName('Novel Helper');
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const window = BrowserWindow.getAllWindows()[0];
		if (window) {
			window.restore();
			window.focus();
		}
	});
	void app.whenReady().then(async () => {
		if (testing) {
			app.dock?.hide();
		}
		const directory = app.getPath('userData');
		app.setAppLogsPath(join(directory, 'logs'));
		const settings = new SettingsStore(directory);
		const secrets = new SecretStore(directory);
		const usage = new UsageStore(join(directory, 'usage'));
		await usage.load();
		const completion = new CompletionService(settings, usage, (provider) => secrets.get(provider));
		const windows = new WindowStore(directory);
		const bookClosed = new Set<(root: string) => void | Promise<void>>();
		const books = new Map<number, BookIndex>();
		const initialResults = new Map<number, OpenResult>();
		let settingsWindow: BrowserWindow | undefined;
		let quitting = false;
		const createWindow = (index?: BookIndex, settingsOnly = false) => {
			const window = new BrowserWindow({
				width: settingsOnly ? 540 : 1440,
				height: settingsOnly ? 430 : 900,
				minWidth: settingsOnly ? 500 : 820,
				minHeight: 400,
				show: false,
				title: 'Novel Helper',
				titleBarStyle: 'hiddenInset',
				backgroundColor: '#fbfaf7',
				webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
			});
			if (index) {
				books.set(window.webContents.id, index);
				index.onChanged((book) => window.webContents.send(channels.bookChanged, book));
				index.onFileChanged((file) => window.webContents.send(channels.fileChanged, file));
				index.start();
				windows.opened(index.root);
			}
			const senderId = window.webContents.id;
			const closeGate = new CloseGate();
			window.on('leave-full-screen', () => window.webContents.send(channels.focusChanged, false));
			window.webContents.on('render-process-gone', () => closeGate.rendererGone());
			const onFlushed = async (event: Electron.IpcMainEvent) => {
				if (event.sender !== window.webContents) {
					return;
				}
				if (index) {
					await completion.buoys(index).dispose();
				}
				await completion.drain(String(senderId));
				closeGate.acknowledge();
				window.close();
			};
			ipcMain.on(channels.flushed, onFlushed);
			window.on('close', (event) => {
				if (!settingsOnly && closeGate.needsFlush()) {
					event.preventDefault();
					window.webContents.send(channels.command, 'flush');
				}
			});
			window.on('closed', () => {
				ipcMain.removeListener(channels.flushed, onFlushed);
				completion.cancel(String(senderId));
				books.delete(senderId);
				initialResults.delete(senderId);
				index?.dispose();
				if (index) {
					bookClosed.forEach((cleanup) => {
						void cleanup(index.root);
					});
				}
				if (index && !quitting) {
					windows.value.open = windows.value.open.filter((root) => root !== index.root);
					windows.save();
				}
			});
			window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			window.webContents.on('will-navigate', (event) => event.preventDefault());
			const query = settingsOnly ? '?settings' : '';
			if (process.env.ELECTRON_RENDERER_URL) {
				void window.loadURL(process.env.ELECTRON_RENDERER_URL + query);
			} else {
				void window.loadFile(join(__dirname, '../renderer/index.html'), settingsOnly ? { query: { settings: '' } } : {});
			}
			window.once('ready-to-show', () => {
				if (!testing) {
					window.show();
				}
			});
			return window;
		};
		const context: MainContext = {
			prepareBookRename,
			reindexBooks: async () => {
				await Promise.all([...books.values()].map((book) => book.reconfigure(settings.get())));
			},
			settings,
			secrets,
			completion,
			windows,
			onBookClosed: (cleanup) => {
				bookClosed.add(cleanup);
			},
			bookFor: (event) => books.get(event.sender.id),
			windowFor: (event) => BrowserWindow.fromWebContents(event.sender)!,
			broadcast: (channel, data) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, data)),
			open: async (root, source) => {
				try {
					root = await resolveBookRoot(root);
					const existing = [...books].find(([, book]) => book.root === root);
					if (existing) {
						const window = BrowserWindow.fromWebContents(webContents.fromId(existing[0])!)!;
						if (!testing) {
							window.restore();
							window.show();
							window.focus();
						}
					} else {
						const prepared = await prepareOpen(root, settings.get());
						if (prepared.roots) {
							return { kind: 'choices', roots: prepared.roots };
						}
						if (prepared.initialize) {
							return { kind: 'empty', root };
						}
						createWindow(prepared.index!);
					}
					if (source && !books.has(source.webContents.id) && source !== settingsWindow) {
						source.close();
					}
					installMenu(context);
					return { kind: 'opened' };
				} catch (error) {
					return { kind: 'error', message: String(error) };
				}
			},
			initialResult: (event) => initialResults.get(event.sender.id),
			openWelcome: (result) => {
				const window = createWindow();
				initialResults.set(window.webContents.id, result);
			},
			openSettings: () => {
				if (!settingsWindow) {
					settingsWindow = createWindow(undefined, true);
					settingsWindow.on('closed', () => {
						settingsWindow = undefined;
					});
				} else if (!testing) {
					settingsWindow.show();
					settingsWindow.focus();
				}
			},
		};
		registerFeatures(context);
		installMenu(context);
		app.on('before-quit', () => {
			quitting = true;
		});
		app.on('window-all-closed', () => {
			if (quitting || testing) {
				app.quit();
			}
		});
		app.on('activate', () => {
			if (!BrowserWindow.getAllWindows().length) {
				createWindow();
			}
		});
		let reopenError: OpenResult | undefined;
		const restored = await restoreBooks(windows, async (root) => {
			const result = await context.open(root);
			if (result.kind === 'error') {
				reopenError = result;
			}
			return result;
		});
		if (!restored) {
			if (reopenError) {
				context.openWelcome(reopenError);
			} else {
				createWindow();
			}
		}
	});
}
