import { BookOpenings } from './window/opening';
import { isAssistantBusy, prepareBookRename } from './assistant/ipc';
import { BookSnapshots } from './assistant/snapshots';
import { prepareOpen } from './scaffold/initialize';
import { resolveBookRoot, restoreBooks } from './window/reopen';
import { CloseGate } from './window/closeGate';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from './settings/store';
import { SecretStore } from './secrets/store';
import { UsageStore } from '../storage/usageStore';
import { CompletionService } from './completion/service';
import { WindowStore } from './window/state';
import { parseTestICloudArg, setTestICloudRoot } from './book/files';
import { isICloudDriveAvailableSync } from './book/icloud';
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
const icloudDir = parseTestICloudArg(process.argv);
if (icloudDir) {
	setTestICloudRoot(icloudDir);
} else if (testing) {
	setTestICloudRoot(join(userData ?? tmpdir(), '__novel_helper_disabled_icloud__'));
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
		const books = new Map<number, BookIndex>();
		const snapshots = new BookSnapshots(
			directory,
			() => settings.get(),
			isAssistantBusy,
			(root, message) => {
				for (const [id, book] of books) {
					if (book.root === root) {
						webContents.fromId(id)?.send(channels.notice, message);
					}
				}
			},
		);
		completion.beforeWrite = (root, work) => snapshots.beforeWrite(root, work);
		const bookClosed = new Set<(root: string) => void | Promise<void>>();
		const openings = new BookOpenings();
		const initialResults = new Map<number, OpenResult>();
		const initialNotices = new Map<number, string>();
		let settingsWindow: BrowserWindow | undefined;
		let quitting = false;
		const createWindow = (index?: BookIndex, settingsOnly = false, notice?: string) => {
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
			if (notice) {
				initialNotices.set(window.webContents.id, notice);
			}
			if (index) {
				books.set(window.webContents.id, index);
				index.onChanged((book) => window.webContents.send(channels.bookChanged, book));
				index.onFileChanged((file) => window.webContents.send(channels.fileChanged, file));
				index.start();
				windows.opened(index.root);
				void snapshots.open(index.root);
			}
			const senderId = window.webContents.id;
			const closeGate = new CloseGate();
			window.on('focus', () => installMenu(context));
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
				initialNotices.delete(senderId);
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
				if (!quitting) {
					installMenu(context);
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
			isBookBusy: isAssistantBusy,
			canSaveFocusedBookToICloud: () => {
				if (!isICloudDriveAvailableSync()) {
					return false;
				}
				const active = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
				const book = active ? books.get(active.webContents.id) : undefined;
				return Boolean(book && !book.inICloud);
			},
			reindexBooks: async () => {
				await Promise.all([...books.values()].map((book) => book.reconfigure(settings.get())));
			},
			settings,
			secrets,
			completion,
			windows,
			snapshots,
			onBookClosed: (cleanup) => {
				bookClosed.add(cleanup);
			},
			bookFor: (event) => books.get(event.sender.id),
			windowFor: (event) => BrowserWindow.fromWebContents(event.sender)!,
			broadcast: (channel, data) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, data)),
			open: async (root, source, selected, options) => {
				try {
					root = await resolveBookRoot(root);
					return await openings.run(root, async () => {
						if (options?.replaceRecent && !windows.value.books[root]) {
							const prior = windows.session(options.replaceRecent);
							if (prior.tabs.length) {
								windows.setSession(root, prior);
							}
						}
						const existing = [...books].find(([, book]) => book.root === root);
						if (existing) {
							const window = BrowserWindow.fromWebContents(webContents.fromId(existing[0])!)!;
							if (options?.notice) {
								window.webContents.send(channels.notice, options.notice);
							}
							if (!testing) {
								window.restore();
								window.show();
								window.focus();
							}
						} else {
							const prepared = await prepareOpen(root, settings.get(), selected);
							if (prepared.roots) {
								return { kind: 'choices', roots: prepared.roots };
							}
							if (prepared.initialize) {
								return { kind: 'empty', root };
							}
							createWindow(prepared.index!, false, options?.notice);
						}
						if (options?.replaceRecent) {
							windows.replaceRecent(options.replaceRecent, root);
						}
						if (source && !books.has(source.webContents.id) && source !== settingsWindow) {
							source.close();
						}
						installMenu(context);
						return { kind: 'opened' };
					});
				} catch (error) {
					return { kind: 'error', message: String(error) };
				}
			},
			initialResult: (event) => initialResults.get(event.sender.id),
			initialNotice: (event) => {
				const notice = initialNotices.get(event.sender.id);
				initialNotices.delete(event.sender.id);
				return notice;
			},
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
