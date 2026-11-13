import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
async function withBook(
	run: (fixture: {
		page: Page;
		app: ElectronApplication;
		book: string;
		root: string;
		data: string;
		menu(command: string): Promise<void>;
	}) => Promise<void>,
	welcome = false,
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-scaffold-e2e-')));
	const book = join(root, 'book'),
		data = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false }));
	await writeFile(
		join(data, 'windows.json'),
		JSON.stringify({
			open: welcome ? [] : [book],
			recent: [book],
			books: { [book]: { tabs: [{ path: chapter, anchor: 0, head: 0 }], active: chapter } },
		}),
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	const app = await electron.launch({ env, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
	const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
	try {
		const page = await app.firstWindow();
		await page.waitForLoadState('domcontentloaded');
		if (!welcome) {
			await expect(page.locator('.editor:visible .cm-content')).toBeVisible();
		}
		const menu = (command: string) =>
			app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('window:command', command), command);
		await run({ page, app, book, root, data, menu });
	} finally {
		await app.close();
		await exited;
		await rm(root, { recursive: true, force: true });
	}
}

test('welcome initializes selected items, opens the book, and discovers nested marked books', async () => {
	await withBook(async ({ page, app, root }) => {
		await expect(page.getByRole('button', { name: '新建一本书', exact: true })).toBeVisible();
		const target = join(root, 'new-book');
		await mkdir(target);
		// Hidden test windows cannot operate the system folder picker.
		await page.evaluate(async (root) => {
			const result = await window.novel.book.open(root);
			return result;
		}, target);
		// book.open returns the result to its caller, just as the welcome button does.
		await app.evaluate(
			({ BrowserWindow }, root) => BrowserWindow.getAllWindows()[0].webContents.send('book:openResult', { kind: 'empty', root }),
			target,
		);
		const dialog = page.getByRole('dialog', { name: '初始化这本书', exact: true });
		await expect(dialog.getByRole('combobox', { name: '目录名称', exact: true })).toHaveValue('en');
		await expect(dialog.getByRole('checkbox', { name: /^chapters / })).toBeChecked();
		await dialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect
			.poll(() =>
				readFile(join(target, '.novel-helper/project.json'), 'utf8').then(
					(text) => JSON.parse(text).language,
					() => undefined,
				),
			)
			.toBe('en');
		await expect.poll(() => app.windows().length).toBe(1);
		const newPage = app.windows()[0];
		await expect(newPage.locator('.topbar strong')).toHaveText('new-book');
		const result = await newPage.evaluate((root) => window.novel.book.open(root), root);
		expect(result.kind).toBe('choices');
		if (result.kind === 'choices') {
			expect(result.roots).toContain(target);
		}
	}, true);
});

test('new chapters, new volumes, safe rename and tab paths follow the chapter tree', async () => {
	await withBook(async ({ page, book, menu }) => {
		await menu('newChapter');
		const create = page.getByRole('dialog', { name: '新建章', exact: true });
		await expect(create.getByRole('textbox', { name: '名字', exact: true })).toHaveValue('第3章 ');
		await create.getByRole('textbox', { name: '名字', exact: true }).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
		await create.getByRole('textbox', { name: '名字', exact: true }).dispatchEvent('keydown', { key: 'Escape', isComposing: true });
		await expect(create).toBeVisible();
		await create.getByRole('textbox', { name: '名字', exact: true }).fill('Chapter 3');
		await create.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-content')).toBeFocused();
		await page.keyboard.insertText('A new chapter.');
		const tree = page.getByRole('tree', { name: '章节', exact: true });
		await tree.getByRole('button', { name: 'Chapter 3', exact: true }).click({ button: 'right' });
		await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
		await page.getByRole('dialog', { name: '重命名', exact: true }).getByRole('textbox').fill('Chapter 3 Renamed');
		await page.getByRole('dialog', { name: '重命名', exact: true }).getByRole('button', { name: '确定', exact: true }).click();
		const renamed = '正文/第一卷 雾港/第一幕 来信/Chapter 3 Renamed.md';
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', renamed);
		expect(await readFile(join(book, renamed), 'utf8')).toBe('A new chapter.');
		await tree.getByRole('button', { name: '全书', exact: true }).click({ button: 'right' });
		await page.getByRole('menuitem', { name: '新建卷或下一层', exact: true }).click();
		const volume = page.getByRole('dialog', { name: '新建卷或下一层', exact: true });
		await volume.getByRole('textbox', { name: '名字', exact: true }).fill('Volume 2');
		await volume.getByRole('textbox', { name: '第一章的名字', exact: true }).fill('Chapter 4');
		await volume.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', '正文/Volume 2/Chapter 4.md');
	});
});

test('whole-book search saves edits, counts all matches, limits rows, respects IME and opens the exact match', async () => {
	await withBook(async ({ page, book, menu }) => {
		const editor = page.locator('.editor:visible .cm-content');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('\nUniqueNeedle');
		await menu('searchBook');
		const input = page.getByRole('textbox', { name: '全书搜索', exact: true });
		await input.fill('uniqueneedle');
		await expect(page.getByRole('option')).toHaveCount(1);
		expect(await readFile(join(book, chapter), 'utf8')).toContain('UniqueNeedle');
		await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
		await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
		await expect(input).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(editor).toBeFocused();
		await page.keyboard.insertText('AtMatch');
		await menu('searchBook');
		await input.fill('AtMatchUniqueNeedle');
		await expect(page.getByRole('option')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await mkdir(join(book, 'notes'));
		await writeFile(join(book, 'notes/search.txt'), 'manyNeedles\n'.repeat(220));
		await menu('searchBook');
		await input.fill('manyneedles');
		await expect(page.getByRole('option')).toHaveCount(200);
		await expect(page.locator('.search-query output')).toHaveText('220 处');
		await expect(page.locator('.book-search strong').first()).toHaveText('manyNeedles');
	});
});

test('settings edit in place, JSON errors do not save, editor preferences update and theme follows the system', async () => {
	await withBook(async ({ page, app, data }) => {
		await page.evaluate(() => window.novel.settings.open());
		await expect.poll(() => app.windows().length).toBe(2);
		const settings = app.windows().find((window) => window !== page)!;
		await settings.getByRole('button', { name: '字体', exact: true }).click();
		await settings.getByRole('textbox', { name: '字体', exact: true }).fill('serif');
		await settings.getByRole('textbox', { name: '字体', exact: true }).press('Enter');
		await settings.getByRole('button', { name: '字号', exact: true }).click();
		await settings.getByRole('textbox', { name: '字号', exact: true }).fill('21');
		await settings.getByRole('textbox', { name: '字号', exact: true }).press('Enter');
		await settings.getByRole('button', { name: '当前行自动居中', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-editor')).toHaveClass(/center-line/);
		await expect(page.locator('.editor:visible .cm-scroller')).toHaveCSS('font-size', '21px');
		await page.locator('.editor:visible .cm-content').click();
		await page.keyboard.press('Meta+ArrowDown');
		await expect
			.poll(() =>
				page.evaluate(() => {
					const editor = document.querySelector('.editor-pane:not([style*="display: none"]) .cm-editor')!;
					// The editor uses the native caret; after jumping to the end it is on the last line.
					const cursor = [...editor.querySelectorAll('.cm-line')].at(-1)!.getBoundingClientRect();
					const scroll = editor.querySelector('.cm-scroller')!.getBoundingClientRect();
					return cursor ? Math.abs(cursor.top + cursor.height / 2 - scroll.top - scroll.height / 2) : Infinity;
				}),
			)
			.toBeLessThan(30);
		await settings.getByRole('button', { name: '命令参数', exact: true }).click();
		const json = settings.getByRole('dialog', { name: '命令参数', exact: true });
		await json.getByRole('textbox').fill('{broken');
		await json.getByRole('button', { name: '确定', exact: true }).click();
		await expect(json.getByRole('alert')).toContainText('JSON 无法解析');
		expect(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'))['assistant.args']).toEqual([]);
		await json.getByRole('textbox').dispatchEvent('keydown', { key: 'Escape', isComposing: true });
		await expect(json).toBeVisible();
		await json.getByRole('textbox').fill('["--arg"]');
		await json.getByRole('button', { name: '确定', exact: true }).click();
		await expect(json).toHaveCount(0);
		expect(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'))['assistant.args']).toEqual(['--arg']);
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(27, 27, 27)');
		await page.emulateMedia({ colorScheme: 'light' });
		await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 250, 247)');
	});
});

test('focus hides chrome and restores sidebars; every left tree offers Finder reveal', async () => {
	await withBook(async ({ page, app, menu, book }) => {
		await page.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第1章 雾里来信', exact: true }).click();
		await menu('split');
		await expect(page.locator('.editor:visible')).toHaveCount(2);
		await menu('left:toggle');
		await expect(page.locator('.sidebar.left')).toBeHidden();
		await menu('focus');
		await expect(page.locator('.topbar')).toBeHidden();
		await expect(page.locator('.editor:visible')).toHaveCount(1);
		await expect(page.locator('.editor-panes')).not.toHaveClass(/split/);
		await expect(page.locator('.tabs')).toBeHidden();
		await expect(page.locator('.statusbar')).toBeHidden();
		await expect(page.locator('.sidebar.right')).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(page.locator('.app')).toHaveClass(/focus-mode/);
		await menu('focus');
		await expect(page.locator('.topbar')).toBeVisible();
		await expect(page.locator('.editor:visible')).toHaveCount(2);
		await expect(page.locator('.sidebar.left')).toBeHidden();
		await expect(page.locator('.sidebar.right')).toBeVisible();
		await menu('left:toggle');
		await app.evaluate(({ shell }) => {
			const state = globalThis as typeof globalThis & { revealed?: string };
			shell.showItemInFolder = (path) => {
				state.revealed = path;
			};
		});
		for (const [section, treeName, row] of [
			['left:0', '章节', '第2章 灯塔'],
			['left:1', '大纲', '全书'],
			['left:2', '设定', '林小满'],
		]) {
			await menu(section);
			await page
				.getByRole('tree', { name: treeName, exact: true })
				.getByRole('button', { name: row, exact: section !== 'left:2' })
				.first()
				.click({ button: 'right' });
			await page.getByRole('menuitem', { name: '在访达中显示', exact: true }).click();
			await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { revealed?: string }).revealed)).toContain(book);
		}
	});
});
