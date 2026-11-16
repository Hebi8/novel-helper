import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	contentPages,
	firstContentPage,
	sendCommand,
	tabBarPage,
	waitForContentPage,
	waitForSettingsPage,
	waitForWelcomePage,
} from './helpers';

const chapter1 = '正文/第一卷 雾港/第一幕 来信/第1章 雾里来信.md';
const chapter2 = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';

function cleanEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
}

async function pageForBook(app: ElectronApplication, bookName: string): Promise<Page> {
	let matched: Page | undefined;
	await expect
		.poll(async () => {
			for (const page of contentPages(app)) {
				const text = await page.evaluate(() => document.querySelector('.topbar strong')?.textContent).catch(() => undefined);
				if (text === bookName) {
					matched = page;
					return true;
				}
			}
			return false;
		})
		.toBe(true);
	return matched!;
}

async function tabTitles(tabBar: Page): Promise<string[]> {
	return tabBar.locator('[role="tab"] .book-tab-title').allTextContents();
}

async function activeTabTitle(tabBar: Page): Promise<string | null> {
	return tabBar.locator('[role="tab"][aria-selected="true"] .book-tab-title').textContent();
}

test('single window hosts multiple book tabs, switches content, updates title on rename, deduplicates reopens, switches via Cmd+1 / Ctrl+Tab / Window menu, and hides tab bar in focus mode', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-tabs-main-e2e-')));
	const bookA = join(root, 'fog-harbor');
	const bookB = join(root, 'north-route');
	const data = join(root, 'data');

	await cp(resolve('examples'), bookA, { recursive: true });
	await cp(resolve('examples'), bookB, { recursive: true });
	await mkdir(data, { recursive: true });

	await writeFile(join(bookB, chapter1), '# 第1章 北境启航\n\n北境的海面上结了一层薄冰，陆青站在船头。\n');
	const markerB = join(bookB, '.novel-helper/project.json');
	const rawMarkerB = await readFile(markerB, 'utf8');
	await writeFile(markerB, rawMarkerB.replace('"book": "全书"', '"book": "全书",\n  "title": "长夜航线"'));

	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [], recent: [], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		const tabs = await tabBarPage(app);
		await tabs.waitForLoadState('domcontentloaded');
		const welcome = await firstContentPage(app);
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		await expect.poll(() => tabTitles(tabs)).toEqual(['欢迎']);

		// ＋ menu hides iCloud and Recent groups when both are empty, and opens Book A via folder picker in place of Welcome tab.
		await app.evaluate(({ dialog }, target) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
		}, bookA);
		await tabs.getByRole('button', { name: '＋', exact: true }).click();
		const plusMenu = tabs.getByRole('menu', { name: '＋', exact: true });
		await expect(plusMenu.getByRole('menuitem', { name: '打开文件夹…', exact: true })).toBeVisible();
		await expect(plusMenu.getByRole('menuitem', { name: '新建一本书…', exact: true })).toBeVisible();
		await expect(plusMenu).not.toContainText('iCloud 里的书');
		await expect(plusMenu).not.toContainText('最近打开');

		const openedA = waitForContentPage(app);
		await plusMenu.getByRole('menuitem', { name: '打开文件夹…', exact: true }).click();
		const pageA = await openedA;
		await pageA.waitForLoadState('domcontentloaded');

		// Welcome tab was replaced in place by Book A (folder name fallback 'fog-harbor'); still 1 BrowserWindow.
		await expect.poll(() => tabTitles(tabs)).toEqual(['fog-harbor']);
		await expect.poll(() => welcome.isClosed()).toBe(true);
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

		await pageA.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		await expect(pageA.locator('.editor:visible .cm-content')).toContainText('林小满');

		// Open Book B (has project.json title '长夜航线') -> still 1 BrowserWindow, 2 tabs, active tab is '长夜航线'.
		const openedB = waitForContentPage(app);
		await pageA.evaluate((target) => window.novel.book.open(target), bookB);
		const pageB = await openedB;
		await pageB.waitForLoadState('domcontentloaded');

		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
		await expect.poll(() => tabTitles(tabs)).toEqual(['fog-harbor', '长夜航线']);
		expect(await activeTabTitle(tabs)).toBe('长夜航线');
		// Right-side close button exists on each book tab (title comes before close button horizontally).
		const closeSide = await tabs
			.locator('[role="tab"]')
			.first()
			.evaluate((el) => {
				const titleRect = el.querySelector('.book-tab-title')!.getBoundingClientRect();
				const closeRect = el.querySelector('.book-tab-close')!.getBoundingClientRect();
				return closeRect.left >= titleRect.right - 2;
			});
		expect(closeSide).toBe(true);

		await pageB.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第1章 雾里来信', exact: true }).click();
		await expect(pageB.locator('.editor:visible .cm-content')).toContainText('北境的海面上结了一层薄冰');

		// Click tab 1 ('fog-harbor') -> content switches back to Book A's open chapter; click tab 2 -> back to Book B.
		await tabs.getByRole('tab').filter({ hasText: 'fog-harbor' }).click();
		await expect.poll(() => activeTabTitle(tabs)).toBe('fog-harbor');
		await expect(pageA.locator('.editor:visible .cm-content')).toContainText('林小满');

		// Rename Book A's title -> tab label and Window menu update immediately.
		const bookRowA = pageA.getByRole('tree', { name: '章节', exact: true }).locator('.book-row');
		await bookRowA.locator('.tree-name').dblclick();
		const titleInput = bookRowA.getByRole('textbox', { name: '重命名书…', exact: true });
		await titleInput.fill('雾港纪事');
		await titleInput.press('Enter');
		await expect.poll(() => tabTitles(tabs)).toEqual(['雾港纪事', '长夜航线']);
		expect(await activeTabTitle(tabs)).toBe('雾港纪事');

		// Reopening an already-open book ('长夜航线') switches to its existing tab instead of opening a duplicate.
		await pageA.evaluate((target) => window.novel.book.open(target), bookB);
		await expect.poll(() => activeTabTitle(tabs)).toBe('长夜航线');
		expect(await tabTitles(tabs)).toEqual(['雾港纪事', '长夜航线']);
		expect(contentPages(app)).toHaveLength(2);

		// Keyboard shortcuts: ⌘1 jumps to tab 1 ('雾港纪事'), ⌘2 jumps to tab 2 ('长夜航线'), ⌃Tab / ⌃⇧Tab cycle tabs.
		await pageB.locator('.editor:visible .cm-content').click();
		await pageB.keyboard.press('Meta+1');
		await expect.poll(() => activeTabTitle(tabs)).toBe('雾港纪事');

		await pageA.keyboard.press('Meta+2');
		await expect.poll(() => activeTabTitle(tabs)).toBe('长夜航线');

		await pageB.keyboard.press('Control+Tab');
		await expect.poll(() => activeTabTitle(tabs)).toBe('雾港纪事');

		await pageA.keyboard.press('Control+Shift+Tab');
		await expect.poll(() => activeTabTitle(tabs)).toBe('长夜航线');

		// Window menu lists all book tabs with active state, and clicking an item switches to that book tab.
		const windowMenuItems = await app.evaluate(({ Menu }) => {
			const winMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === '窗口');
			return (
				winMenu?.submenu?.items.filter((item) => item.type === 'checkbox').map((item) => ({ label: item.label, checked: item.checked })) ??
				[]
			);
		});
		expect(windowMenuItems).toEqual([
			{ label: '雾港纪事', checked: false },
			{ label: '长夜航线', checked: true },
		]);
		await app.evaluate(({ Menu }) => {
			const winMenu = Menu.getApplicationMenu()!.items.find((item) => item.label === '窗口')!;
			const item = winMenu.submenu!.items.find((entry) => entry.label === '雾港纪事')!;
			item.click(item, undefined, {});
		});
		await expect.poll(() => activeTabTitle(tabs)).toBe('雾港纪事');

		// Focus mode hides the book tab bar and expands the active book view to y = 0; leaving focus mode restores both.
		await sendCommand(app, 'focus');
		await expect(pageA.locator('.app')).toHaveClass(/focus-mode/);
		const focusLayout = await app.evaluate(({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0];
			const children = win.contentView.children as Electron.WebContentsView[];
			const tb = children.find((child) => child.webContents.getURL().includes('tabbar'))!;
			const activeView = children.find((child) => child !== tb && child.getVisible())!;
			return { tabBarVisible: tb.getVisible(), bookY: activeView.getBounds().y };
		});
		expect(focusLayout).toEqual({ tabBarVisible: false, bookY: 0 });

		await sendCommand(app, 'focus');
		await expect(pageA.locator('.app')).not.toHaveClass(/focus-mode/);
		const restoredLayout = await app.evaluate(({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0];
			const children = win.contentView.children as Electron.WebContentsView[];
			const tb = children.find((child) => child.webContents.getURL().includes('tabbar'))!;
			const activeView = children.find((child) => child !== tb && child.getVisible())!;
			return { tabBarVisible: tb.getVisible(), bookY: activeView.getBounds().y };
		});
		expect(restoredLayout).toEqual({ tabBarVisible: true, bookY: 38 });

		// Settings window remains a separate BrowserWindow.
		const settingsOpened = waitForSettingsPage(app);
		await pageA.evaluate(() => window.novel.settings.open());
		const settings = await settingsOpened;
		await settings.waitForLoadState('domcontentloaded');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('＋ menu opens iCloud and recent books, restarts restore all tabs and selected tab, Save to iCloud replaces tab in place, closing flushes unsaved text and leaves Welcome, and conflict cancels window close keeping all tabs', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-tabs-lifecycle-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const cloudBooksDir = join(icloud, 'com~apple~CloudDocs/hebi8L');
	const book1 = join(root, '雾港');
	const book2 = join(root, '旧稿');
	const cloudBook = join(cloudBooksDir, '北境');
	const data = join(root, 'data');

	await mkdir(cloudBooksDir, { recursive: true });
	await cp(resolve('examples'), book1, { recursive: true });
	await cp(resolve('examples'), book2, { recursive: true });
	await cp(resolve('examples'), cloudBook, { recursive: true });
	await mkdir(data, { recursive: true });

	const originalChap2Book1 = await readFile(join(book1, chapter2), 'utf8');
	const originalChap2Book2 = await readFile(join(book2, chapter2), 'utf8');

	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [book1], recent: [book1, book2], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	const closeApp = async () => {
		if (!app) {
			return;
		}
		const current = app;
		const currentExit = exited;
		app = undefined;
		exited = undefined;
		await current.close();
		await currentExit;
	};

	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		const tabs = await tabBarPage(app);
		await tabs.waitForLoadState('domcontentloaded');
		await pageForBook(app, '雾港');
		await expect.poll(() => tabTitles(tabs)).toEqual(['雾港']);

		// 1. ＋ menu lists both 'iCloud 里的书' ('北境') and '最近打开' ('旧稿'), and clicking opens each in a new tab.
		await tabs.getByRole('button', { name: '＋', exact: true }).click();
		const plusMenu = tabs.getByRole('menu', { name: '＋', exact: true });
		await expect(plusMenu).toContainText('iCloud 里的书');
		await expect(plusMenu).toContainText('最近打开');
		const opened2 = waitForContentPage(app);
		await plusMenu.getByRole('menuitem', { name: '旧稿', exact: true }).click();
		await (await opened2).waitForLoadState('domcontentloaded');
		await expect.poll(() => tabTitles(tabs)).toEqual(['雾港', '旧稿']);

		await tabs.getByRole('button', { name: '＋', exact: true }).click();
		const opened3 = waitForContentPage(app);
		await tabs.getByRole('menu', { name: '＋', exact: true }).getByRole('menuitem', { name: '北境', exact: true }).click();
		await (await opened3).waitForLoadState('domcontentloaded');
		await expect.poll(() => tabTitles(tabs)).toEqual(['雾港', '旧稿', '北境']);
		expect(await activeTabTitle(tabs)).toBe('北境');

		// Select middle tab ('旧稿'), then restart -> restores all 3 tabs in exact order with '旧稿' selected!
		await tabs.getByRole('tab').filter({ hasText: '旧稿' }).click();
		await expect.poll(() => activeTabTitle(tabs)).toBe('旧稿');
		await closeApp();

		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		const tabs2 = await tabBarPage(app);
		await tabs2.waitForLoadState('domcontentloaded');
		await expect.poll(() => contentPages(app!).length).toBe(3);
		await expect.poll(() => tabTitles(tabs2)).toEqual(['雾港', '旧稿', '北境']);
		await expect.poll(() => activeTabTitle(tabs2)).toBe('旧稿');

		// 2. Save to iCloud on middle tab ('旧稿', index 1) replaces tab AT index 1 without opening a new BrowserWindow.
		const page2 = await pageForBook(app, '旧稿');
		await page2.locator('.topbar button.topbar-book').click();
		await page2.getByRole('menuitem', { name: '存到 iCloud', exact: true }).click();
		const replaced = waitForContentPage(app);
		await page2.getByRole('dialog', { name: '存到 iCloud', exact: true }).getByRole('button', { name: '确定', exact: true }).click();
		const cloudPage2 = await replaced;
		await cloudPage2.waitForLoadState('domcontentloaded');

		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
		await expect.poll(() => contentPages(app!).length).toBe(3);
		expect(await tabTitles(tabs2)).toEqual(['雾港', '旧稿', '北境']);
		expect(await activeTabTitle(tabs2)).toBe('旧稿');
		expect(existsSync(join(cloudBooksDir, '旧稿'))).toBe(true);
		const boot2 = await cloudPage2.evaluate(() => window.novel.window.bootstrap());
		expect(boot2.book?.root).toBe(join(cloudBooksDir, '旧稿'));
		expect(boot2.book?.inICloud).toBe(true);
		await expect(cloudPage2.locator('.notice[role="alert"]')).toContainText('已存到 iCloud');
		await cloudPage2.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 3. Window close when one tab ('雾港', inactive tab 0) has an unresolved conflict cancels window close and keeps ALL 3 tabs.
		await tabs2.getByRole('tab').filter({ hasText: '雾港' }).click();
		const page1 = await pageForBook(app, '雾港');
		await page1.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const editor1 = page1.locator('.editor:visible .cm-content');
		await expect(editor1).toContainText('林小满');
		await editor1.click();
		await page1.keyboard.press('Meta+ArrowDown');
		await page1.keyboard.insertText('未保存的本地版本。');
		await writeFile(join(book1, chapter2), originalChap2Book1 + '外部冲突版本。');
		await expect(page1.getByRole('button', { name: '留我的', exact: true })).toBeVisible();

		// Switch away to '北境' (tab 2) and type unsaved clean edit there, then attempt to close the BrowserWindow.
		await tabs2.getByRole('tab').filter({ hasText: '北境' }).click();
		const pageNorth = await pageForBook(app, '北境');
		await pageNorth.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const editorNorth = pageNorth.locator('.editor:visible .cm-content');
		await expect(editorNorth).toContainText('林小满');
		await editorNorth.click();
		await pageNorth.keyboard.press('Meta+ArrowDown');
		await pageNorth.keyboard.insertText('切走标签保存的字。');

		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0].close();
		});

		// Window did NOT close; active tab switched to conflicted '雾港', clean edit in '北境' flushed, and ALL 3 tabs remain open!
		await expect.poll(() => activeTabTitle(tabs2)).toBe('雾港');
		await expect.poll(() => readFile(join(cloudBook, chapter2), 'utf8')).toContain('切走标签保存的字。');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
		expect(await tabTitles(tabs2)).toEqual(['雾港', '旧稿', '北境']);
		expect(contentPages(app)).toHaveLength(3);
		await expect(page1.getByRole('button', { name: '留我的', exact: true })).toBeVisible();

		// Quitting the app while '雾港' still has an unresolved conflict also cancels quit and keeps all 3 tabs.
		await tabs2.getByRole('tab').filter({ hasText: '北境' }).click();
		await expect.poll(() => activeTabTitle(tabs2)).toBe('北境');
		await app.evaluate(({ app: electronApp }) => {
			electronApp.quit();
		});
		await expect.poll(() => activeTabTitle(tabs2)).toBe('雾港');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
		expect(await tabTitles(tabs2)).toEqual(['雾港', '旧稿', '北境']);

		// Resolve conflict in '雾港' by clicking '留我的'.
		await page1.getByRole('button', { name: '留我的', exact: true }).click();
		await expect.poll(() => readFile(join(book1, chapter2), 'utf8')).toBe(originalChap2Book1 + '未保存的本地版本。');

		// 4. Closing a tab with unsaved edits (before 1s autosave) saves edits to disk.
		await tabs2.getByRole('tab').filter({ hasText: '旧稿' }).click();
		await cloudPage2.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const editor2 = cloudPage2.locator('.editor:visible .cm-content');
		await expect(editor2).toContainText('林小满');
		await editor2.click();
		await cloudPage2.keyboard.press('Meta+ArrowDown');
		await cloudPage2.keyboard.insertText('关标签前刚敲下的字。');
		// Immediately close '旧稿' via ⌘W before autosave timer fires.
		await cloudPage2.keyboard.press('Meta+w');
		await expect.poll(() => tabTitles(tabs2)).toEqual(['雾港', '北境']);
		expect(await readFile(join(cloudBooksDir, '旧稿', chapter2), 'utf8')).toBe(originalChap2Book2 + '关标签前刚敲下的字。');

		// 5. Close remaining two book tabs via close buttons -> closing the last book tab leaves a Welcome tab in the window.
		await tabs2.getByRole('button', { name: '关闭标签 雾港', exact: true }).click();
		await expect.poll(() => tabTitles(tabs2)).toEqual(['北境']);

		const welcomeReturned = waitForWelcomePage(app);
		await tabs2.getByRole('button', { name: '关闭标签 北境', exact: true }).click();
		const finalWelcome = await welcomeReturned;
		await finalWelcome.waitForLoadState('domcontentloaded');

		await expect.poll(() => tabTitles(tabs2)).toEqual(['欢迎']);
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
		await expect(finalWelcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
	} finally {
		await closeApp();
		await rm(root, { recursive: true, force: true });
	}
});
