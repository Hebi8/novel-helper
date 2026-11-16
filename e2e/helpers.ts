import { type ElectronApplication, type Page } from '@playwright/test';
import type { MenuCommand, OpenResult } from '../src/shared/api';

export function isContentPage(page: Page): boolean {
	const url = page.url();
	return url !== '' && !url.includes('tabbar') && !url.includes('settings');
}

export function isBookPage(page: Page): boolean {
	return isContentPage(page) && !page.url().includes('welcome');
}

export function contentPages(app: ElectronApplication): Page[] {
	return app.windows().filter(isContentPage);
}

export async function firstContentPage(app: ElectronApplication): Promise<Page> {
	const existing = contentPages(app)[0];
	if (existing) {
		return existing;
	}
	return app.waitForEvent('window', isContentPage);
}

export function waitForContentPage(app: ElectronApplication): Promise<Page> {
	return app.waitForEvent('window', isBookPage);
}

export function waitForWelcomePage(app: ElectronApplication): Promise<Page> {
	return app.waitForEvent('window', (page) => page.url().includes('welcome'));
}

export async function tabBarPage(app: ElectronApplication): Promise<Page> {
	const existing = app.windows().find((page) => page.url().includes('tabbar'));
	if (existing) {
		return existing;
	}
	return app.waitForEvent('window', (page) => page.url().includes('tabbar'));
}

export function waitForSettingsPage(app: ElectronApplication): Promise<Page> {
	const existing = app.windows().find((page) => page.url().includes('settings'));
	if (existing) {
		return Promise.resolve(existing);
	}
	return app.waitForEvent('window', (page) => page.url().includes('settings'));
}

export async function sendCommand(app: ElectronApplication, command: MenuCommand): Promise<void> {
	await app.evaluate(({ BrowserWindow, webContents }, cmd) => {
		const win = BrowserWindow.getAllWindows()[0];
		const visibleChild = win?.contentView.children.find(
			(child) =>
				'webContents' in child && child.getVisible() && !(child as Electron.WebContentsView).webContents.getURL().includes('tabbar'),
		) as Electron.WebContentsView | undefined;
		const target =
			visibleChild?.webContents ??
			webContents
				.getAllWebContents()
				.find(
					(wc) =>
						!wc.isDestroyed() && wc.getURL().includes('index.html') && !wc.getURL().includes('tabbar') && !wc.getURL().includes('settings'),
				);
		target?.send('window:command', cmd);
	}, command);
}

export async function sendOpenResult(app: ElectronApplication, result: OpenResult): Promise<void> {
	await app.evaluate(({ BrowserWindow, webContents }, value) => {
		const win = BrowserWindow.getAllWindows()[0];
		const visibleChild = win?.contentView.children.find(
			(child) =>
				'webContents' in child && child.getVisible() && !(child as Electron.WebContentsView).webContents.getURL().includes('tabbar'),
		) as Electron.WebContentsView | undefined;
		const target =
			visibleChild?.webContents ??
			webContents
				.getAllWebContents()
				.find(
					(wc) =>
						!wc.isDestroyed() && wc.getURL().includes('index.html') && !wc.getURL().includes('tabbar') && !wc.getURL().includes('settings'),
				);
		target?.send('book:openResult', value);
	}, result);
}
