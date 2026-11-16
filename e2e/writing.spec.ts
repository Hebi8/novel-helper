import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeServer, stream, openaiText, OPENAI_END } from '../src/test/fakeServer';
import { firstContentPage, waitForContentPage } from './helpers';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const continuation = (n: number) => `门后传来第${n}声脚步，灯光照亮了潮湿的石阶。`;
async function withBook(
	run: (fixture: {
		app: ElectronApplication;
		page: Page;
		book: string;
		data: string;
		original: string;
		server: Awaited<ReturnType<typeof fakeServer>>;
	}) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), 'novel-e2e-'));
	const book = join(root, 'book');
	const data = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	const missing = join(root, 'missing');
	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [missing], recent: [missing], books: {} }));
	const original = await readFile(join(book, chapter), 'utf8');
	let count = 0;
	const server = await fakeServer((res) => stream(res, [openaiText(continuation(++count)), OPENAI_END]));
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ provider: 'openaiCompatible', 'openaiCompatible.model': 'test', 'openaiCompatible.baseUrl': server.baseUrl }),
	);
	const launchEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	let app: ElectronApplication | undefined;
	let page: Page | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({ env: launchEnv, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
		const child = app.process();
		exited = new Promise((resolve) => child.once('exit', () => resolve()));
		const welcome = await firstContentPage(app);
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		const next = waitForContentPage(app);
		await welcome.evaluate((root) => window.novel.book.open(root), book);
		page = await next;
		await page.waitForLoadState('domcontentloaded');
		await expect(page.getByRole('tree', { name: '章节', exact: true })).toContainText('book');
		await page
			.getByRole('tree', { name: '章节', exact: true })
			.getByRole('button', { name: /第2章 灯塔/ })
			.click();
		await expect(page.locator('.cm-content')).toContainText('林小满');
		await run({ app, page, book, data, original, server });
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
}
async function endOfChapter(page: Page) {
	await page.locator('.cm-content').click();
	await page.keyboard.press('Meta+ArrowDown');
}
test('open a book, accept ghost text, autosave, reload external edits, and continue again after Tab', async () => {
	await withBook(async ({ app, page, book, original, server }) => {
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true);
		expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
		await page.waitForTimeout(900);
		expect(server.received).toHaveLength(0);
		await endOfChapter(page);
		await expect(page.locator('.ghost-text')).toHaveText(continuation(1));
		await page.keyboard.press('Tab');
		await expect(page.locator('.ghost-text')).toHaveCount(0);
		await expect(page.locator('.ghost-text')).toHaveText(continuation(2));
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(original + continuation(1));
		await page.keyboard.press('Escape');
		const changed = original + '外部改写后的章节。';
		await writeFile(join(book, chapter), changed);
		await expect(page.locator('.cm-content')).toContainText('外部改写后的章节。');
		await page.waitForTimeout(900);
		expect(server.received).toHaveLength(2);
	});
});
test('composition hides ghost text, cancellation restores it, and committing starts one new request without saving preedit', async () => {
	await withBook(async ({ page, book, original, server }) => {
		await endOfChapter(page);
		await expect(page.locator('.ghost-text')).toHaveText(continuation(1));
		const cdp = await page.context().newCDPSession(page);
		try {
			await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
			await expect(page.locator('.ghost-text')).toHaveCount(0);
			await page.waitForTimeout(1200);
			expect(server.received).toHaveLength(1);
			expect(await readFile(join(book, chapter), 'utf8')).toBe(original);
			await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
			await expect(page.locator('.ghost-text')).toHaveText(continuation(1), { timeout: 500 });
			expect(server.received).toHaveLength(1);
			await page.waitForTimeout(900);
			expect(server.received).toHaveLength(1);
			await expect(page.locator('.ghost-text')).toHaveText(continuation(1));
			await cdp.send('Input.imeSetComposition', { text: 'hao', selectionStart: 3, selectionEnd: 3 });
			await page.waitForTimeout(1100);
			expect(await readFile(join(book, chapter), 'utf8')).toBe(original);
			await cdp.send('Input.insertText', { text: '你好' });
			await expect(page.locator('.ghost-text')).toHaveCount(0);
			await expect(page.locator('.ghost-text')).toHaveText(continuation(2));
			expect(server.received).toHaveLength(2);
			await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(original + '你好');
		} finally {
			// A simulated composition does not end on its own, and the window waits for it before saving and closing.
			await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
			await cdp.detach();
		}
	});
});
test('selection and search focus do not request, and a crashed renderer can close', async () => {
	await withBook(async ({ app, page, server }) => {
		await endOfChapter(page);
		await expect(page.locator('.ghost-text')).toHaveText(continuation(1));
		await page.keyboard.press('Escape');
		await page.keyboard.press('Meta+a');
		await page.keyboard.press('Alt+Backslash');
		await page.waitForTimeout(900);
		expect(server.received).toHaveLength(1);
		await page.keyboard.press('Meta+f');
		await page.waitForTimeout(900);
		expect(server.received).toHaveLength(1);
		const closed = await app.evaluate(async ({ BrowserWindow, webContents }) => {
			const window = BrowserWindow.getAllWindows()[0];
			new BrowserWindow({ show: false });
			const bookWc = webContents
				.getAllWebContents()
				.find(
					(wc) =>
						!wc.isDestroyed() && wc.getURL().includes('index.html') && !wc.getURL().includes('tabbar') && !wc.getURL().includes('settings'),
				)!;
			await new Promise<void>((resolve) => {
				bookWc.once('render-process-gone', () => resolve());
				bookWc.forcefullyCrashRenderer();
			});
			const closed = new Promise<boolean>((resolve) => window.once('closed', () => resolve(true)));
			window.close();
			return closed;
		});
		expect(closed).toBe(true);
	});
});
test('closing during composition ends it and saves what the editor shows', async () => {
	await withBook(async ({ app, page, book, original }) => {
		await page.evaluate(() => window.novel.settings.set('trigger', 'manual'));
		await app.evaluate(({ BrowserWindow }) => {
			new BrowserWindow({ show: false });
		});
		await endOfChapter(page);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
		await expect(page.locator('.cm-content')).toContainText('ni');
		expect(await readFile(join(book, chapter), 'utf8')).toBe(original);
		const closed = page.waitForEvent('close');
		await page.evaluate(() => window.novel.window.close());
		await closed;
		// Losing focus makes the input method commit what it was composing; the file gets the text that was on screen.
		expect(await readFile(join(book, chapter), 'utf8')).toBe(original + 'ni');
	});
});
test('unreadable chapters stay visible and opening errors can be dismissed or cleared by success', async () => {
	await withBook(async ({ page, book }) => {
		await writeFile(join(book, '正文/bad.txt'), Buffer.from([255]));
		const bad = page.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: /bad/ });
		await expect(bad).toBeVisible();
		await bad.click();
		await expect(page.getByRole('alert')).toContainText('这个文件不是 UTF-8 编码');
		await expect(page.getByRole('alert')).not.toContainText('Error');
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();
		await expect(page.getByRole('alert')).toHaveCount(0);
		await bad.click();
		await expect(page.getByRole('alert')).toBeVisible();
		await page
			.getByRole('tree', { name: '章节', exact: true })
			.getByRole('button', { name: /第2章 灯塔/ })
			.click();
		await expect(page.getByRole('alert')).toHaveCount(0);
	});
});
