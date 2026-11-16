import { app, BrowserWindow, ipcMain, WebContentsView, type WebContents } from 'electron';
import { join } from 'node:path';
import { zh } from '../../renderer/strings';
import { channels, type BookTabItem, type OpenResult, type TabBarState } from '../../shared/api';
import type { BookSnapshots } from '../assistant/snapshots';
import type { BookIndex } from '../book/indexer';
import type { CompletionService } from '../completion/service';
import type { SettingsStore } from '../settings/store';
import { CloseGate } from './closeGate';
import type { WindowStore } from './state';

export const TAB_BAR_HEIGHT = 38;

interface TabEntry {
	id: number;
	view: WebContentsView;
	index?: BookIndex;
	ready: boolean;
	closeGate: CloseGate;
	disposeListeners: () => void;
	closing?: boolean;
	flushPromise?: Promise<boolean>;
	resolveFlush?: (saved: boolean) => void;
}

export interface BookWindowOptions {
	testing: boolean;
	preloadPath: string;
	books: Map<number, BookIndex>;
	initialResults: Map<number, OpenResult>;
	initialNotices: Map<number, string>;
	savingToICloud: Map<number, 'copying' | 'closing'>;
	trashing: Set<number>;
	settings: SettingsStore;
	windows: WindowStore;
	completion: CompletionService;
	snapshots: BookSnapshots;
	isQuitting(): boolean;
	cancelQuitting(): void;
	onBookClosed(root: string): void;
	onStateChanged(): void;
	onClosed(): void;
}

function createView(preload: string): WebContentsView {
	const view = new WebContentsView({
		webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	view.webContents.on('will-navigate', (event) => event.preventDefault());
	return view;
}

function loadRenderer(wc: WebContents, query?: Record<string, string>): void {
	if (process.env.ELECTRON_RENDERER_URL) {
		const search = query ? '?' + new URLSearchParams(query).toString() : '';
		void wc.loadURL(process.env.ELECTRON_RENDERER_URL + search);
	} else {
		void wc.loadFile(join(__dirname, '../renderer/index.html'), query ? { query } : {});
	}
}

export class BookWindow {
	readonly window: BrowserWindow;
	private readonly tabBar: WebContentsView;
	private readonly tabs: TabEntry[] = [];
	private readonly retiringTabs = new Map<number, TabEntry>();
	private activeId: number | undefined;
	private focusMode = false;
	private menuExpanded = false;
	private windowFlushInProgress = false;
	private windowClosingApproved = false;

	constructor(private readonly options: BookWindowOptions) {
		this.window = new BrowserWindow({
			width: 1440,
			height: 900,
			minWidth: 820,
			minHeight: 400,
			show: false,
			title: zh.app,
			titleBarStyle: 'hiddenInset',
			trafficLightPosition: { x: 14, y: 13 },
			backgroundColor: '#fbfaf7',
			webPreferences: { preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
		});
		this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		this.window.webContents.on('will-navigate', (event) => event.preventDefault());

		this.tabBar = createView(options.preloadPath);
		this.tabBar.setBackgroundColor('#00000000');
		this.window.contentView.addChildView(this.tabBar);
		this.layout();
		loadRenderer(this.tabBar.webContents, { tabbar: '' });

		ipcMain.on(channels.flushed, this.onFlushed);
		this.window.on('resize', () => this.layout());
		this.window.on('focus', () => this.options.onStateChanged());
		this.window.on('blur', () => {
			if (this.menuExpanded) {
				this.setMenuExpanded(false);
			}
		});
		this.window.on('leave-full-screen', () => {
			this.focusMode = false;
			this.layout();
			for (const tab of this.tabs) {
				if (!tab.view.webContents.isDestroyed()) {
					tab.view.webContents.send(channels.focusChanged, false);
				}
			}
		});
		this.window.on('close', (event) => this.handleWindowClose(event));
		this.window.on('closed', () => this.handleWindowClosed());
	}

	private readonly onFlushed = (event: Electron.IpcMainEvent, saved = true) => {
		const retiring = this.retiringTabs.get(event.sender.id);
		if (retiring) {
			this.retiringTabs.delete(retiring.id);
			void this.options.completion.drain(String(retiring.id)).finally(() => {
				this.teardownTabEntry(retiring);
				this.publishTabBar();
				this.options.onStateChanged();
			});
			return;
		}
		const tab = this.tabs.find((item) => item.id === event.sender.id);
		tab?.resolveFlush?.(saved !== false);
	};

	isLocked(): boolean {
		return this.tabs.some((tab) => this.options.savingToICloud.get(tab.id) === 'copying' || this.options.trashing.has(tab.id));
	}

	activeSenderId(): number | undefined {
		return this.activeId;
	}

	activeWebContents(): WebContents | undefined {
		const tab = this.activeTab();
		return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : undefined;
	}

	allWebContents(): WebContents[] {
		const list: WebContents[] = [];
		if (!this.tabBar.webContents.isDestroyed()) {
			list.push(this.tabBar.webContents);
		}
		for (const tab of this.tabs) {
			if (!tab.view.webContents.isDestroyed()) {
				list.push(tab.view.webContents);
			}
		}
		return list;
	}

	ownsSender(senderId: number): boolean {
		return this.tabBar.webContents.id === senderId || this.tabs.some((tab) => tab.id === senderId) || this.retiringTabs.has(senderId);
	}

	markReady(senderId: number): void {
		const tab = this.tabs.find((item) => item.id === senderId);
		if (tab) {
			tab.ready = true;
		}
	}

	findBookTab(root: string): TabEntry | undefined {
		return this.tabs.find((tab) => tab.index?.root === root);
	}

	tabBarState(): TabBarState {
		return {
			tabs: this.tabItems(),
			locked: this.isLocked(),
			theme: this.options.settings.get()['appearance.theme'],
		};
	}

	tabItems(): BookTabItem[] {
		return this.tabs.map((tab) => ({
			id: tab.id,
			kind: tab.index ? 'book' : 'welcome',
			root: tab.index?.root,
			title: tab.index ? tab.index.book.name : zh.welcome,
			active: tab.id === this.activeId,
		}));
	}

	publishTabBar(): void {
		if (!this.tabBar.webContents.isDestroyed()) {
			this.tabBar.webContents.send(channels.tabsChanged, this.tabBarState());
		}
	}

	setMenuExpanded(expanded: boolean): void {
		if (this.menuExpanded === expanded) {
			return;
		}
		this.menuExpanded = expanded;
		this.layout();
	}

	setFocusMode(enabled: boolean): void {
		this.focusMode = enabled;
		if (enabled) {
			this.menuExpanded = false;
		}
		this.window.setFullScreen(enabled);
		this.layout();
		for (const tab of this.tabs) {
			if (tab.index && !tab.view.webContents.isDestroyed()) {
				tab.view.webContents.send(channels.focusChanged, enabled);
			}
		}
	}

	openBook(index: BookIndex, options?: { notice?: string; activate?: boolean; persistActive?: boolean }): void {
		const activate = options?.activate ?? true;
		const persistActive = options?.persistActive ?? activate;
		const welcomePos = this.tabs.findIndex((tab) => !tab.index);
		const entry = this.createTabEntry(index, options?.notice);
		if (welcomePos !== -1) {
			const [welcomeTab] = this.tabs.splice(welcomePos, 1, entry);
			welcomeTab.view.setVisible(false);
			this.teardownTabEntry(welcomeTab);
		} else {
			this.tabs.push(entry);
		}
		this.options.windows.opened(index.root, persistActive);
		if (activate || this.activeId === undefined) {
			this.activateEntry(entry, false);
		} else {
			this.layout();
			this.publishTabBar();
			this.options.onStateChanged();
		}
	}

	replaceBook(oldSenderId: number, newIndex: BookIndex, notice?: string): void {
		const pos = this.tabs.findIndex((tab) => tab.id === oldSenderId);
		const oldTab = pos !== -1 ? this.tabs[pos] : undefined;
		const entry = this.createTabEntry(newIndex, notice);
		if (oldTab && oldTab.index) {
			this.tabs[pos] = entry;
			oldTab.view.setVisible(false);
			this.retiringTabs.set(oldTab.id, oldTab);
			this.options.windows.replaceOpen(oldTab.index.root, newIndex.root);
			if (this.activeId === oldTab.id) {
				this.activeId = entry.id;
				this.window.setTitle(newIndex.book.name);
			}
		} else {
			this.tabs.push(entry);
			this.options.windows.opened(newIndex.root, true);
			this.activeId = entry.id;
			this.window.setTitle(newIndex.book.name);
		}
		this.layout();
		this.publishTabBar();
		this.options.onStateChanged();
	}

	openWelcome(result?: OpenResult): void {
		const existing = this.tabs.find((tab) => !tab.index);
		if (existing) {
			if (result && !existing.view.webContents.isDestroyed()) {
				existing.view.webContents.send(channels.openResult, result);
			}
			this.activateEntry(existing, false);
			return;
		}
		const entry = this.createTabEntry(undefined, undefined, result);
		this.tabs.push(entry);
		this.activateEntry(entry, false);
	}

	selectByRoot(root: string): void {
		const tab = this.findBookTab(root);
		if (tab) {
			this.selectTab(tab.id);
		}
	}

	selectTab(id: number): void {
		if (this.isLocked()) {
			return;
		}
		const next = this.tabs.find((tab) => tab.id === id);
		if (!next) {
			return;
		}
		this.menuExpanded = false;
		if (this.activeId === next.id) {
			this.layout();
			return;
		}
		const current = this.activeTab();
		if (current?.index && !current.view.webContents.isDestroyed()) {
			current.view.webContents.send(channels.command, 'blur');
		}
		this.activateEntry(next, true);
	}

	selectIndex(index: number): void {
		if (index >= 0 && index < this.tabs.length) {
			this.selectTab(this.tabs[index].id);
		}
	}

	cycleTab(step: number): void {
		if (this.tabs.length <= 1 || this.isLocked()) {
			return;
		}
		const currentIdx = this.tabs.findIndex((tab) => tab.id === this.activeId);
		const nextIdx = ((currentIdx === -1 ? 0 : currentIdx) + step + this.tabs.length) % this.tabs.length;
		this.selectTab(this.tabs[nextIdx].id);
	}

	async closeTab(id = this.activeId): Promise<boolean> {
		if (id === undefined || this.isLocked() || this.windowFlushInProgress) {
			return false;
		}
		const tab = this.tabs.find((item) => item.id === id);
		if (!tab || tab.closing) {
			return false;
		}
		if (!tab.index) {
			this.window.close();
			return true;
		}
		if (tab.ready && tab.closeGate.needsFlush()) {
			const saved = await this.flushTab(tab);
			if (!saved || this.isLocked() || !this.tabs.includes(tab)) {
				if (!saved && this.tabs.includes(tab)) {
					this.selectTab(tab.id);
				}
				return false;
			}
		}
		tab.closing = true;
		await this.options.completion.buoys(tab.index).dispose();
		await this.options.completion.drain(String(tab.id));
		tab.closeGate.acknowledge();
		const pos = this.tabs.indexOf(tab);
		if (pos === -1) {
			return false;
		}
		this.tabs.splice(pos, 1);
		if (this.tabs.length === 0) {
			if (this.focusMode) {
				this.setFocusMode(false);
			}
			this.options.windows.closed(tab.index.root, undefined);
			this.openWelcome();
		} else {
			if (this.activeId === tab.id) {
				const next = this.tabs[Math.min(pos, this.tabs.length - 1)];
				this.activeId = next.id;
				this.window.setTitle(next.index ? next.index.book.name : zh.app);
			}
			this.options.windows.closed(tab.index.root, this.activeTab()?.index?.root);
			this.layout();
		}
		this.teardownTabEntry(tab);
		this.publishTabBar();
		this.options.onStateChanged();
		return true;
	}

	showAndFocus(): void {
		if (!this.options.testing && !this.window.isDestroyed()) {
			this.window.restore();
			this.window.show();
			this.window.focus();
		}
	}

	private activeTab(): TabEntry | undefined {
		return this.tabs.find((tab) => tab.id === this.activeId);
	}

	private activateEntry(entry: TabEntry, persistActive: boolean): void {
		this.activeId = entry.id;
		if (!this.window.isDestroyed()) {
			this.window.setTitle(entry.index ? entry.index.book.name : zh.app);
		}
		if (persistActive) {
			this.options.windows.setActive(entry.index?.root);
		}
		this.layout();
		if (this.window.isVisible() && !entry.view.webContents.isDestroyed()) {
			entry.view.webContents.focus();
		}
		this.publishTabBar();
		this.options.onStateChanged();
	}

	private createTabEntry(index?: BookIndex, notice?: string, result?: OpenResult): TabEntry {
		const view = createView(this.options.preloadPath);
		const id = view.webContents.id;
		if (notice) {
			this.options.initialNotices.set(id, notice);
		}
		if (result) {
			this.options.initialResults.set(id, result);
		}
		const closeGate = new CloseGate();
		const unsubscribes: Array<() => void> = [];
		if (index) {
			this.options.books.set(id, index);
			unsubscribes.push(
				index.onChanged((book) => {
					if (!view.webContents.isDestroyed()) {
						view.webContents.send(channels.bookChanged, book);
					}
					if (this.activeId === id && !this.window.isDestroyed()) {
						this.window.setTitle(book.name);
					}
					this.publishTabBar();
					this.options.onStateChanged();
				}),
				index.onFileChanged((file) => {
					if (!view.webContents.isDestroyed()) {
						view.webContents.send(channels.fileChanged, file);
					}
				}),
			);
			index.start();
			void this.options.snapshots.open(index.root);
		}
		const entry: TabEntry = {
			id,
			view,
			index,
			ready: false,
			closeGate,
			disposeListeners: () => {
				while (unsubscribes.length) {
					unsubscribes.pop()!();
				}
			},
		};
		view.webContents.on('render-process-gone', () => {
			closeGate.rendererGone();
			entry.resolveFlush?.(true);
		});
		view.webContents.once('destroyed', () => {
			closeGate.rendererGone();
			entry.resolveFlush?.(true);
		});
		view.webContents.once('did-finish-load', () => {
			if (!this.options.testing && !this.window.isDestroyed() && !this.window.isVisible()) {
				this.window.show();
			}
		});
		this.window.contentView.addChildView(view, 0);
		loadRenderer(view.webContents, index ? undefined : { welcome: '' });
		return entry;
	}

	private flushTab(tab: TabEntry): Promise<boolean> {
		if (!tab.ready || !tab.closeGate.needsFlush() || tab.view.webContents.isDestroyed()) {
			return Promise.resolve(true);
		}
		if (tab.flushPromise) {
			return tab.flushPromise;
		}
		tab.flushPromise = new Promise<boolean>((resolve) => {
			tab.resolveFlush = (saved) => {
				tab.flushPromise = undefined;
				tab.resolveFlush = undefined;
				resolve(saved);
			};
		});
		tab.view.webContents.send(channels.command, 'flush');
		return tab.flushPromise;
	}

	private teardownTabEntry(entry: TabEntry): void {
		entry.disposeListeners();
		this.options.completion.cancel(String(entry.id));
		this.options.books.delete(entry.id);
		this.options.initialResults.delete(entry.id);
		this.options.initialNotices.delete(entry.id);
		this.options.savingToICloud.delete(entry.id);
		this.options.trashing.delete(entry.id);
		if (entry.index) {
			entry.index.dispose();
			this.options.onBookClosed(entry.index.root);
		}
		if (!this.window.isDestroyed()) {
			this.window.contentView.removeChildView(entry.view);
		}
		const closeWc = () => {
			if (!entry.view.webContents.isDestroyed()) {
				entry.view.webContents.close();
			}
		};
		if (this.window.isDestroyed()) {
			closeWc();
		} else {
			setTimeout(closeWc, 50).unref();
		}
	}

	private layout(): void {
		if (this.window.isDestroyed()) {
			return;
		}
		const { width, height } = this.window.getContentBounds();
		if (this.focusMode) {
			this.tabBar.setVisible(false);
			for (const tab of this.tabs) {
				const isActive = tab.id === this.activeId;
				tab.view.setVisible(isActive);
				if (isActive) {
					tab.view.setBounds({ x: 0, y: 0, width, height });
				}
			}
			return;
		}
		this.tabBar.setVisible(true);
		this.tabBar.setBounds({ x: 0, y: 0, width, height: this.menuExpanded ? height : TAB_BAR_HEIGHT });
		const viewBounds = { x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) };
		for (const tab of this.tabs) {
			tab.view.setVisible(tab.id === this.activeId);
			tab.view.setBounds(viewBounds);
		}
	}

	private handleWindowClose(event: Electron.Event): void {
		if (this.windowClosingApproved) {
			return;
		}
		if (this.isLocked()) {
			event.preventDefault();
			this.options.cancelQuitting();
			return;
		}
		const needsFlush = this.tabs.some((tab) => Boolean(tab.index && tab.ready && tab.closeGate.needsFlush()));
		if (!needsFlush) {
			return;
		}
		event.preventDefault();
		if (this.windowFlushInProgress) {
			return;
		}
		this.windowFlushInProgress = true;
		void (async () => {
			try {
				for (const tab of [...this.tabs]) {
					if (!this.tabs.includes(tab) || !tab.index || !tab.ready || !tab.closeGate.needsFlush()) {
						continue;
					}
					const saved = await this.flushTab(tab);
					if (!saved || this.isLocked()) {
						this.options.cancelQuitting();
						if (!saved && this.tabs.includes(tab)) {
							this.selectTab(tab.id);
						}
						return;
					}
				}
				for (const tab of [...this.tabs]) {
					if (tab.index) {
						await this.options.completion.buoys(tab.index).dispose();
					}
					await this.options.completion.drain(String(tab.id));
					tab.closeGate.acknowledge();
				}
				if (!this.window.isDestroyed()) {
					this.windowClosingApproved = true;
					if (this.options.isQuitting()) {
						app.quit();
					} else {
						this.window.close();
					}
				}
			} finally {
				this.windowFlushInProgress = false;
			}
		})();
	}

	private handleWindowClosed(): void {
		ipcMain.removeListener(channels.flushed, this.onFlushed);
		const allTabs = [...this.tabs, ...this.retiringTabs.values()];
		this.tabs.length = 0;
		this.retiringTabs.clear();
		this.activeId = undefined;
		if (!this.options.isQuitting()) {
			this.options.windows.value.open = [];
			this.options.windows.value.active = undefined;
			this.options.windows.save();
		}
		for (const tab of allTabs) {
			this.teardownTabEntry(tab);
		}
		if (!this.tabBar.webContents.isDestroyed()) {
			this.tabBar.webContents.close();
		}
		this.options.onClosed();
		if (!this.options.isQuitting()) {
			this.options.onStateChanged();
		}
	}
}
