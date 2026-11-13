import { test, expect, _electron as electron } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeServer, stream, openaiText, openaiUsage, OPENAI_END } from '../src/test/fakeServer';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
test('lore cards, quick open, grouped edits, manual buoys, split and last-request report', async () => {
	const root = await mkdtemp(join(tmpdir(), 'novel-reference-e2e-'));
	const book = join(root, 'book');
	const data = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	const server = await fakeServer((res) =>
		stream(res, [openaiText('门后传来一声叹息。'), openaiUsage({ prompt_tokens: 24, completion_tokens: 8 }), OPENAI_END]),
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			trigger: 'manual',
			provider: 'openaiCompatible',
			'openaiCompatible.model': 'test',
			'openaiCompatible.baseUrl': server.baseUrl,
		}),
	);
	await writeFile(
		join(data, 'windows.json'),
		JSON.stringify({ open: [book], recent: [book], books: { [book]: { tabs: [{ path: chapter, anchor: 0, head: 0 }], active: chapter } } }),
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	const app = await electron.launch({ env, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
	const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
	try {
		const page = await app.firstWindow();
		await page.waitForLoadState('domcontentloaded');
		await expect(page.locator('.status-buoy')).toContainText('周伯收信');
		await expect(page.locator('.sidebar.right .buoy-mark')).toContainText('写到这里');
		await expect(page.locator('.sidebar.right .position-summary')).toContainText('周伯收信');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true);
		const name = page.locator('.editor:visible .lore-name').filter({ hasText: '林小满' }).first();
		await name.hover();
		await expect(page.locator('.lore-tooltip')).toContainText('林小满');
		await page.keyboard.press('Escape');
		await expect(page.locator('.lore-tooltip')).toHaveCount(0);
		await name.click();
		await page.keyboard.press('Meta+i');
		await expect(page.locator('.lore-tooltip')).toContainText('林小满');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Meta+k');
		await page.keyboard.press('Meta+i');
		await expect(page.locator('.lore-tooltip')).toBeVisible();
		await page.keyboard.press('Escape');
		await page.keyboard.press('F12');
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('林小满');
		await expect(page.locator('.editor:visible .cm-content')).toContainText('aliases:');
		await page.keyboard.press('Meta+p');
		await page.getByRole('textbox', { name: '快速打开', exact: true }).fill('潮汐');
		await page.keyboard.press('Enter');
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('潮汐钟');
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '设定', exact: true }).click();
		await expect(page.locator('.sidebar.left summary').filter({ hasText: '物件' })).toBeVisible();
		const lorePath = '设定/潮汐钟.md';
		const before = await readFile(join(book, lorePath), 'utf8');
		await page.locator('.sidebar.left .lore-row').filter({ hasText: '潮汐钟' }).click({ button: 'right' });
		await page.getByRole('menuitem', { name: '设为常驻', exact: true }).click();
		await expect.poll(() => readFile(join(book, lorePath), 'utf8')).toBe(before.replace(/\n---\n/, '\nalways: true\n---\n'));
		const buoyFile = join(book, '.novel-helper/buoys', chapter + '.json');
		const originalMarks = JSON.parse(await readFile(buoyFile, 'utf8')).marks;
		await page.getByRole('button', { name: '前进一格', exact: true }).click();
		await expect.poll(async () => JSON.parse(await readFile(buoyFile, 'utf8')).marks.length).toBe(originalMarks.length + 1);
		expect(JSON.parse(await readFile(buoyFile, 'utf8')).marks.at(-1).by).toBe('manual');
		await expect(page.locator('.status-buoy')).toContainText('商量渡海');
		await page.keyboard.press('Meta+Backslash');
		await expect(page.locator('.editor-panes.split')).toBeVisible();
		await expect(page.locator('.editor:visible')).toHaveCount(2);
		await page.keyboard.press('Meta+Backslash');
		await expect(page.locator('.editor:visible')).toHaveCount(1);
		await page.getByRole('tab').filter({ hasText: '第2章 灯塔' }).click();
		await page.locator('.editor:visible .cm-content').click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('Alt+Backslash');
		await expect(page.locator('.ghost-text')).toContainText('门后传来一声叹息。');
		await app.evaluate(({ Menu, BrowserWindow }) => {
			const menu = Menu.getApplicationMenu()!.items.find((item) => item.label === '续写')!.submenu!;
			const item = menu.items.find((item) => item.label === '上次发给模型的内容')!;
			if (item.label !== '上次发给模型的内容') {
				throw new Error('Missing report menu item');
			}
			BrowserWindow.getAllWindows()[0].webContents.send('window:command', 'report');
		});
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('上次发给模型的内容');
		await expect(page.locator('.editor:visible .cm-content')).toContainText('商量渡海');
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('contenteditable', 'false');
		expect(server.received.length).toBeGreaterThan(0);
		expect(JSON.stringify(server.received.at(-1)!.body)).toContain('商量渡海');
	} finally {
		await app.close();
		await exited;
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});
