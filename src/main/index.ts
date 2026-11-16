import { BookOpenings } from './window/opening';
import { BookWindow } from './window/bookWindow';
import { isAssistantBusy, prepareBookRename } from './assistant/ipc';
import { BookSnapshots } from './assistant/snapshots';
import { prepareOpen } from './scaffold/initialize';
import { resolveBookRoot, restoreBooks } from './window/reopen';
import { app, BrowserWindow, webContents } from 'electron';
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
import { resolveUserDataPath, USER_DATA_DIR_NAME } from './window/paths';
import { zh } from '../renderer/strings';
import { channels, type OpenResult } from '../shared/api';
import type { MainContext } from './context';
const testing = process.argv.includes('--test-mode');
const explicitUserData = process.argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const userData = resolveUserDataPath(app.getPath('appData'), process.argv);
app.setName(USER_DATA_DIR_NAME);
app.setPath('userData', userData);
const icloudDir = parseTestICloudArg(process.argv);
if (icloudDir) {
	setTestICloudRoot(icloudDir);
} else if (testing) {
	setTestICloudRoot(join(explicitUserData ?? tmpdir(), '__novel_helper_disabled_icloud__'));
}
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	let mainShell: BookWindow | undefined;
	app.on('second-instance', () => {
		const window = mainShell?.window ?? BrowserWindow.getAllWindows()[0];
		if (window && !window.isDestroyed()) {
			window.restore();
			window.focus();
		}
	});
	void app.whenReady().then(async () => {
		app.setName(zh.app);
		app.setAboutPanelOptions({ applicationName: zh.app });
		if (testing) {
			app.dock?.hide();
		} else if (!app.isPackaged) {
			app.dock?.setIcon(join(__dirname, '../../build/icon.png'));
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
		const savingToICloud = new Map<number, 'copying' | 'closing'>();
		const trashing = new Set<number>();
		const preloadPath = join(__dirname, '../preload/index.js');
		let settingsWindow: BrowserWindow | undefined;
		let quitting = false;

		const createSettingsWindow = () => {
			const window = new BrowserWindow({
				width: 540,
				height: 430,
				minWidth: 500,
				minHeight: 400,
				show: false,
				title: zh.app,
				titleBarStyle: 'hiddenInset',
				backgroundColor: '#fbfaf7',
				webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
			});
			window.on('focus', () => installMenu(context));
			window.on('closed', () => {
				settingsWindow = undefined;
				if (!quitting) {
					installMenu(context);
				}
			});
			window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			window.webContents.on('will-navigate', (event) => event.preventDefault());
			if (process.env.ELECTRON_RENDERER_URL) {
				void window.loadURL(process.env.ELECTRON_RENDERER_URL + '?settings');
			} else {
				void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { settings: '' } });
			}
			window.once('ready-to-show', () => {
				if (!testing) {
					window.show();
				}
			});
			return window;
		};

		const ensureMainShell = () => {
			if (!mainShell) {
				mainShell = new BookWindow({
					testing,
					preloadPath,
					books,
					initialResults,
					initialNotices,
					savingToICloud,
					trashing,
					settings,
					windows,
					completion,
					snapshots,
					isQuitting: () => quitting,
					cancelQuitting: () => {
						quitting = false;
					},
					onBookClosed: (root) => {
						bookClosed.forEach((cleanup) => {
							void cleanup(root);
						});
					},
					onStateChanged: () => installMenu(context),
					onClosed: () => {
						mainShell = undefined;
					},
				});
			}
			return mainShell;
		};

		const isSettingsFocused = () => Boolean(settingsWindow && BrowserWindow.getFocusedWindow() === settingsWindow);
		const focusedBookSenderId = () => (isSettingsFocused() ? undefined : mainShell?.activeSenderId());

		const context: MainContext = {
			prepareBookRename,
			isBookBusy: isAssistantBusy,
			hasFocusedBook: () => {
				const id = focusedBookSenderId();
				return Boolean(id !== undefined && books.has(id));
			},
			canSaveFocusedBookToICloud: () => {
				if (!isICloudDriveAvailableSync()) {
					return false;
				}
				const id = focusedBookSenderId();
				const book = id !== undefined ? books.get(id) : undefined;
				return Boolean(book && !book.inICloud);
			},
			isFocusedBookSavingToICloud: () => {
				const id = focusedBookSenderId();
				return Boolean(id !== undefined && savingToICloud.has(id));
			},
			setSavingToICloud: (senderId, state) => {
				if (state) {
					savingToICloud.set(senderId, state);
				} else {
					savingToICloud.delete(senderId);
				}
				mainShell?.publishTabBar();
				installMenu(context);
			},
			isSavingToICloud: (senderId) => savingToICloud.has(senderId),
			isFocusedBookTrashing: () => {
				const id = focusedBookSenderId();
				return Boolean(id !== undefined && trashing.has(id));
			},
			setTrashing: (senderId, active) => {
				if (active) {
					trashing.add(senderId);
				} else {
					trashing.delete(senderId);
				}
				mainShell?.publishTabBar();
				installMenu(context);
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
			windowFor: (event) => BrowserWindow.fromWebContents(event.sender) ?? mainShell?.window ?? settingsWindow!,
			mainWindow: () => mainShell?.window,
			activeSender: () => mainShell?.activeWebContents(),
			sendCommand: (command) => {
				if (isSettingsFocused() && settingsWindow && !settingsWindow.webContents.isDestroyed()) {
					settingsWindow.webContents.send(channels.command, command);
					return;
				}
				mainShell?.activeWebContents()?.send(channels.command, command);
			},
			sendOpenResult: (result, target) => {
				const recipient = target && !target.isDestroyed() ? target : mainShell?.activeWebContents();
				if (recipient) {
					recipient.send(channels.openResult, result);
				} else {
					context.openWelcome(result);
				}
			},
			setFocusMode: (event, enabled) => {
				if (mainShell?.ownsSender(event.sender.id)) {
					mainShell.setFocusMode(enabled);
				} else {
					BrowserWindow.fromWebContents(event.sender)?.setFullScreen(enabled);
				}
			},
			markBootstrapped: (event) => {
				mainShell?.markReady(event.sender.id);
			},
			closeView: (event) => {
				if (settingsWindow && event.sender === settingsWindow.webContents) {
					settingsWindow.close();
					return;
				}
				if (mainShell?.ownsSender(event.sender.id)) {
					void mainShell.closeTab(event.sender.id);
					return;
				}
				BrowserWindow.fromWebContents(event.sender)?.close();
			},
			tabBarState: () =>
				mainShell?.tabBarState() ?? {
					tabs: [],
					locked: false,
					theme: settings.get()['appearance.theme'],
				},
			bookTabs: () => (mainShell?.tabItems() ?? []).filter((tab) => tab.kind === 'book'),
			selectTab: (id) => {
				mainShell?.selectTab(id);
				mainShell?.showAndFocus();
			},
			selectTabIndex: (index) => {
				mainShell?.selectIndex(index);
			},
			cycleTab: (step) => {
				mainShell?.cycleTab(step);
			},
			closeTab: async (id, sender) => {
				if (id === undefined && ((sender && settingsWindow && sender === settingsWindow.webContents) || isSettingsFocused())) {
					settingsWindow?.close();
					return;
				}
				await mainShell?.closeTab(id);
			},
			setTabMenuExpanded: (expanded) => {
				mainShell?.setMenuExpanded(expanded);
			},
			broadcast: (channel, data) => {
				for (const wc of mainShell?.allWebContents() ?? []) {
					wc.send(channel, data);
				}
				if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.webContents.isDestroyed()) {
					settingsWindow.webContents.send(channel, data);
				}
				if (channel === channels.settingsChanged) {
					mainShell?.publishTabBar();
				}
			},
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
						const existing = mainShell?.findBookTab(root);
						if (existing) {
							mainShell!.selectTab(existing.id);
							if (options?.notice && !existing.view.webContents.isDestroyed()) {
								existing.view.webContents.send(channels.notice, options.notice);
							}
							mainShell!.showAndFocus();
						} else {
							const prepared = await prepareOpen(root, settings.get(), selected);
							if (prepared.roots) {
								return { kind: 'choices', roots: prepared.roots };
							}
							if (prepared.initialize) {
								return { kind: 'empty', root };
							}
							const shell = ensureMainShell();
							if (options?.replaceSender && source) {
								shell.replaceBook(source.id, prepared.index!, options.notice);
							} else {
								shell.openBook(prepared.index!, {
									notice: options?.notice,
									activate: options?.activate,
									persistActive: options?.persistActive,
								});
							}
							shell.showAndFocus();
						}
						if (options?.replaceRecent) {
							windows.replaceRecent(options.replaceRecent, root);
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
				const shell = ensureMainShell();
				shell.openWelcome(result);
				shell.showAndFocus();
				installMenu(context);
			},
			openSettings: () => {
				if (!settingsWindow) {
					settingsWindow = createSettingsWindow();
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
			if (!mainShell) {
				context.openWelcome();
			} else {
				mainShell.showAndFocus();
			}
		});
		const rememberedActive = windows.value.active;
		let reopenError: OpenResult | undefined;
		const restored = await restoreBooks(windows, async (root) => {
			const result = await context.open(root, undefined, false, { activate: false, persistActive: false });
			if (result.kind === 'error') {
				reopenError = result;
			}
			return result;
		});
		if (!restored) {
			context.openWelcome(reopenError);
		} else if (mainShell) {
			if (rememberedActive && mainShell.findBookTab(rememberedActive)) {
				mainShell.selectByRoot(rememberedActive);
			} else {
				windows.setActive(mainShell.tabItems().find((tab) => tab.active)?.root);
			}
		}
	});
}
