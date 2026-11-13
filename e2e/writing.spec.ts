import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeServer, stream, openaiText, OPENAI_END } from '../src/test/fakeServer';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const continuation = '门后传来熟悉的脚步声，灯光照亮了潮湿的石阶。';
test('open a book, accept ghost text, autosave, and reload an external change', async () => {
	const root = await mkdtemp(join(tmpdir(), 'novel-e2e-'));
	const book = join(root, 'book'),
		data = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	const original = await readFile(join(book, chapter), 'utf8');
	let server: Awaited<ReturnType<typeof fakeServer>> | undefined;
	await writeFile(join(data, 'settings.json'), JSON.stringify({ provider: 'openaiCompatible', 'openaiCompatible.model': 'test' }));
	let app: ElectronApplication | undefined;
	try {
		const launchEnv = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
			),
		);
		app = await electron.launch({ env: launchEnv, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
		const welcome = await app.firstWindow();
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		server = await fakeServer((res) => stream(res, [openaiText(continuation), OPENAI_END]));
		await welcome.evaluate((baseUrl) => window.novel.settings.set('openaiCompatible.baseUrl', baseUrl), server.baseUrl);
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		const next = app.waitForEvent('window');
		await welcome.evaluate((root) => window.novel.book.open(root), book);
		const page = await next;
		await page.waitForLoadState('domcontentloaded');
		await expect(page.getByRole('tree')).toContainText('全书');
		await expect(page.getByRole('tree')).toContainText('第一卷 雾港');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true);
		expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
		await page
			.getByRole('tree')
			.getByRole('button', { name: /第2章 灯塔/ })
			.click();
		const editor = page.locator('.cm-content');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await expect(page.locator('.ghost-text')).toHaveText(continuation);
		await page.keyboard.press('Tab');
		await expect(page.locator('.ghost-text')).toHaveCount(0);
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(original + continuation);
		const changed = original + '外部改写后的章节。';
		await writeFile(join(book, chapter), changed);
		await expect(editor).toContainText('外部改写后的章节。');
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(changed);
		await page.screenshot({ path: 'test-results/writing.png' });
		await app.close();
		expect(app.process().exitCode).not.toBeNull();
		app = undefined;
	} finally {
		if (app) {
			await app.close();
		}
		await server?.close();
		await rm(root, { recursive: true, force: true });
	}
});
