import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeServer, stream, openaiText, openaiUsage, OPENAI_END } from '../src/test/fakeServer';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
async function withReferenceBook(
	run: (fixture: {
		page: Page;
		app: ElectronApplication;
		book: string;
		menu(command: string): Promise<void>;
		server: Awaited<ReturnType<typeof fakeServer>>;
	}) => Promise<void>,
) {
	// Saved tabs are keyed by the book's real path, and the temporary directory sits behind a symlink.
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-reference-e2e-')));
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
		// Menu shortcuts are handled by the system menu, which synthetic key presses do not reach.
		const menu = (command: string) =>
			app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('window:command', command), command);
		await page.waitForLoadState('domcontentloaded');
		await expect(page.locator('.status-buoy')).toContainText('周伯收信');
		await run({ page, app, book, menu, server });
	} finally {
		await app.close();
		await exited;
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
}

test('lore cards, quick open, grouped edits, manual buoys, split and last-request report', async () => {
	await withReferenceBook(async ({ page, app, book, menu, server }) => {
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
		await menu('quickOpen');
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
		await menu('split');
		await expect(page.locator('.editor-panes.split')).toBeVisible();
		await expect(page.locator('.editor:visible')).toHaveCount(2);
		await menu('split');
		await expect(page.locator('.editor:visible')).toHaveCount(1);
		await page.getByRole('tab').filter({ hasText: '第2章 灯塔' }).click();
		await page.locator('.editor:visible .cm-content').click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('Alt+Backslash');
		await expect(page.locator('.ghost-text')).toContainText('门后传来一声叹息。');
		expect(
			await app.evaluate(({ Menu }) =>
				Menu.getApplicationMenu()!
					.items.find((item) => item.label === '续写')!
					.submenu!.items.some((item) => item.label === '上次发给模型的内容'),
			),
		).toBe(true);
		await menu('report');
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('上次发给模型的内容');
		// The editor only renders the lines in view; the buoy's place in the request is checked on the server below.
		await expect(page.locator('.editor:visible .cm-content')).toContainText('用到的条目');
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('contenteditable', 'false');
		expect(server.received.length).toBeGreaterThan(0);
		expect(JSON.stringify(server.received.at(-1)!.body)).toContain('商量渡海');
	});
});

test('lore shortcuts preserve selection; cards survive autosave and lore updates and close on blur', async () => {
	await withReferenceBook(async ({ page, book }) => {
		const editor = page.locator('.editor:visible .cm-content');
		await editor.click();
		await page.keyboard.press('Meta+ArrowUp');
		await page.keyboard.press('Shift+ArrowRight');
		const selection = () =>
			page.evaluate(() => {
				const s = window.getSelection()!;
				return [s.toString(), s.anchorOffset, s.focusOffset];
			});
		const before = await selection();
		await page.keyboard.press('Meta+i');
		expect(await selection()).toEqual(before);
		await page.keyboard.press('Meta+k');
		await page.keyboard.press('Meta+i');
		expect(await selection()).toEqual(before);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('字');
		await page.keyboard.press('Meta+ArrowUp');
		const name = page.locator('.editor:visible .lore-name').filter({ hasText: '林小满' }).first();
		await name.click();
		await page.keyboard.press('Meta+i');
		await expect(page.locator('.lore-tooltip')).toBeVisible();
		await page.locator('.lore-tooltip').evaluate((element) => element.setAttribute('data-preserved', 'yes'));
		await page.waitForTimeout(2500);
		await expect(page.locator('.lore-tooltip')).toHaveAttribute('data-preserved', 'yes');
		const loreFile = join(book, '人物/林小满.md');
		const raw = await readFile(loreFile, 'utf8');
		await writeFile(loreFile, raw.replace('十七岁，雾港邮局的送信员', '十八岁，雾港邮局的送信员'));
		await expect(page.locator('.lore-tooltip')).toContainText('十八岁');
		await page.locator('.sidebar.right .segments').getByRole('button', { name: '看设定', exact: true }).click();
		await expect(page.locator('.lore-tooltip')).toHaveCount(0);
		await name.hover();
		await expect(page.locator('.lore-tooltip')).toBeVisible();
		await name.click();
		await page.keyboard.press('Meta+i');
		await page.waitForTimeout(500);
		await page.mouse.move(10, 10);
		await page.keyboard.press('Escape');
		await expect(page.locator('.lore-tooltip')).toHaveCount(0);
	});
});

test('quick open uses unique filtered rows, preserves composition, and renders at most fifty matches', async () => {
	await withReferenceBook(async ({ page, book, menu }) => {
		await mkdir(join(book, '笔记'));
		await Promise.all(Array.from({ length: 65 }, (_, i) => writeFile(join(book, '笔记', `筛选样本${i}.md`), '笔记')));
		await menu('quickOpen');
		const input = page.getByRole('textbox', { name: '快速打开', exact: true });
		await input.fill('筛选样本');
		await expect(page.getByRole('option')).toHaveCount(50);
		await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
		await expect(input).toBeVisible();
		await input.fill('第2章');
		await expect.poll(async () => (await page.getByRole('option').allTextContents()).every((text) => text.includes('第2章'))).toBe(true);
		await expect(page.getByRole('option')).toHaveCount(2);
		await page.keyboard.press('ArrowDown');
		const selected = await page.getByRole('option', { selected: true }).locator('small').textContent();
		await page.keyboard.press('Enter');
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', selected!);
	});
});

test('an unreadable outline does not hide lore or buoys, and opening an outline preserves its inode', async () => {
	await withReferenceBook(async ({ page, book }) => {
		await writeFile(join(book, '大纲/bad.md'), '甲\r\n乙\n');
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '大纲', exact: true }).click();
		await expect(page.locator('.sidebar.left .tree').getByRole('button', { name: 'bad', exact: true })).toBeVisible();
		await expect(page.locator('.editor:visible .lore-name').filter({ hasText: '林小满' }).first()).toBeVisible();
		await expect(page.locator('.status-buoy')).toContainText('周伯收信');
		await page.locator('.sidebar.left .tree').getByRole('button', { name: 'bad', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('混用了两种换行符');
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '章节', exact: true }).click();
		const path = join(book, chapter.replace('正文/', '大纲/'));
		const before = await stat(path);
		await page
			.locator('.sidebar.left .tree-row')
			.filter({ has: page.getByRole('button', { name: '第2章 灯塔', exact: true }) })
			.getByRole('button', { name: '大纲 ✓', exact: true })
			.click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', chapter.replace('正文/', '大纲/'));
		const after = await stat(path);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});
});

test('split requires two tabs and collapses after closing a side', async () => {
	await withReferenceBook(async ({ page, menu }) => {
		await expect(page.getByRole('button', { name: '并排', exact: true })).toBeDisabled();
		await menu('split');
		await expect(page.locator('.editor-panes.split')).toHaveCount(0);
		await menu('quickOpen');
		await page.getByRole('textbox', { name: '快速打开', exact: true }).fill('潮汐钟');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('button', { name: '并排', exact: true })).toBeEnabled();
		await menu('split');
		await expect(page.locator('.editor:visible')).toHaveCount(2);
		await menu('closeTab');
		await expect(page.locator('.editor:visible')).toHaveCount(1);
		await expect(page.locator('.editor-panes.split')).toHaveCount(0);
		await expect(page.getByRole('button', { name: '并排', exact: true })).toBeDisabled();
	});
});

test('lore type edits trim whitespace, reject empty types, and popovers preserve composition and return focus', async () => {
	await withReferenceBook(async ({ page, book }) => {
		await page.locator('.editor:visible .cm-content').click();
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '设定', exact: true }).click();
		const row = page.locator('.sidebar.left .lore-row').filter({ hasText: '潮汐钟' });
		await row.click({ button: 'right' });
		await page.getByRole('menuitem', { name: '改类型', exact: true }).click();
		// An input with a suggestion list is exposed as a combobox, not a textbox.
		const type = page.getByRole('dialog', { name: '改类型', exact: true }).locator('input');
		await type.fill('   ');
		await expect(page.getByRole('button', { name: '确定', exact: true })).toBeDisabled();
		await type.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
		await expect(type).toBeVisible();
		await type.fill('  新类型  ');
		await page.getByRole('button', { name: '确定', exact: true }).click();
		await expect.poll(() => readFile(join(book, '设定/潮汐钟.md'), 'utf8')).toContain('type: 新类型\n');
		await expect(page.locator('.editor:visible .cm-content')).toBeFocused();
		await row.click({ button: 'right' });
		await page.keyboard.press('Escape');
		await expect(page.locator('.editor:visible .cm-content')).toBeFocused();
		await row.click({ button: 'right' });
		await page.getByRole('menuitem', { name: '改别名', exact: true }).click();
		const aliases = page.getByRole('textbox', { name: '别名', exact: true });
		await aliases.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
		await expect(aliases).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('.editor:visible .cm-content')).toBeFocused();
	});
});
