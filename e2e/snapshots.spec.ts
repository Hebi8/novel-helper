import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { firstContentPage, waitForContentPage, waitForSettingsPage } from './helpers';

const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';

async function withApp(
	run: (fixture: {
		app: ElectronApplication;
		welcome: Page;
		page: Page;
		book: string;
		data: string;
		snapshotDir: string;
		original: string;
	}) => Promise<void>,
	setupBook?: (book: string) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), 'novel-snapshots-e2e-'));
	const book = join(root, 'book');
	const data = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	await setupBook?.(book);
	await mkdir(data);
	const realBook = await realpath(book);
	const snapshotDir = join(data, 'snapshots', createHash('sha256').update(realBook).digest('hex').slice(0, 16));
	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [], recent: [], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false }));
	const original = await readFile(join(book, chapter), 'utf8');
	const launchEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({ env: launchEnv, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
		exited = new Promise((resolve) => app!.process().once('exit', () => resolve()));
		const welcome = await firstContentPage(app);
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		const next = waitForContentPage(app);
		await welcome.evaluate((target) => window.novel.book.open(target), book);
		const page = await next;
		await page.waitForLoadState('domcontentloaded');
		await page
			.getByRole('tree', { name: '章节', exact: true })
			.getByRole('button', { name: /第2章 灯塔/ })
			.click();
		await expect(page.locator('.writing .cm-content')).toContainText('林小满');
		await run({ app, welcome, page, book, data, snapshotDir, original });
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
}

test('timed snapshots configure in settings, record manual saves, show diffs, block on conflicts, revert, and undo', async () => {
	await withApp(async ({ app, page, book, original }) => {
		const settingsOpened = waitForSettingsPage(app);
		await page.evaluate(() => window.novel.settings.open());
		const settingsPage = await settingsOpened;
		await settingsPage.waitForLoadState('domcontentloaded');

		const intervalLabel = '定时快照间隔（分钟，0 为关）';
		const keepLabel = '定时快照保留份数';
		await settingsPage.getByRole('tab', { name: '助手', exact: true }).click();
		await expect(settingsPage.getByRole('heading', { name: '快照', exact: true })).toBeVisible();
		await expect(settingsPage.getByRole('slider', { name: intervalLabel, exact: true })).toHaveValue('10');
		await expect(settingsPage.getByRole('slider', { name: keepLabel, exact: true })).toHaveValue('100');

		await settingsPage.getByRole('slider', { name: intervalLabel, exact: true }).fill('1');
		await expect(settingsPage.getByRole('slider', { name: intervalLabel, exact: true })).toHaveValue('1');
		await page.evaluate(() => window.novel.settings.set('snapshots.intervalMinutes', 0.01));
		await settingsPage.evaluate(() => window.novel.window.close());

		await page.getByRole('button', { name: '收起右栏', exact: true }).click();

		await page.waitForTimeout(700);
		const editor = page.locator('.writing .cm-content');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('手写第一版。');
		const v1 = original + '手写第一版。';
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(v1);

		await page.evaluate(() => window.novel.settings.set('snapshots.intervalMinutes', 10));
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('接着写坏的一段。');
		const v2 = v1 + '接着写坏的一段。';
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(v2);

		await page.getByRole('button', { name: '快照', exact: true }).click();
		const history = page.getByRole('dialog', { name: '快照', exact: true });
		await expect(history).toContainText('定时 · 1 个文件');
		await history.getByRole('button', { name: `看差异 · ${chapter}`, exact: true }).click();

		const diff = page.getByRole('dialog', { name: `看差异 · ${chapter}`, exact: true });
		await expect(diff).toContainText('上一份快照');
		await expect(diff).toContainText('这份快照');
		await expect(diff.locator('.cm-content').last()).toContainText('手写第一版。');
		await page.keyboard.press('Escape');
		await expect(history).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(history).toHaveCount(0);

		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('未保存的本地改动。');
		await writeFile(join(book, chapter), v2 + '磁盘外部改动。');
		await expect(page.getByRole('button', { name: '留我的', exact: true })).toBeVisible();

		await page.getByRole('button', { name: '快照', exact: true }).click();
		await page.getByRole('dialog', { name: '快照', exact: true }).getByRole('button', { name: '退回到这个时间点', exact: true }).click();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '有文件未保存或冲突尚未解决' })).toBeVisible();
		expect(await readFile(join(book, chapter), 'utf8')).toBe(v2 + '磁盘外部改动。');

		await page.getByRole('button', { name: '留我的', exact: true }).click();
		const v3 = v2 + '未保存的本地改动。';
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(v3);

		await page.getByRole('button', { name: '快照', exact: true }).click();
		await page.getByRole('dialog', { name: '快照', exact: true }).getByRole('button', { name: '退回到这个时间点', exact: true }).click();
		await expect(page.getByRole('dialog', { name: '退回到这个时间点', exact: true })).toBeVisible();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();

		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(v1);
		await expect(editor).toContainText('手写第一版。');
		await expect(editor).not.toContainText('接着写坏的一段。');

		await page.getByRole('button', { name: '快照', exact: true }).click();
		const updatedHistory = page.getByRole('dialog', { name: '快照', exact: true });
		await updatedHistory.getByRole('button', { name: '撤销这次退回', exact: true }).click();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();

		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(v3);
		await expect(editor).toContainText('未保存的本地改动。');
	});
});

test('closing a book window saves a timed snapshot under userData while ignoring legacy in-book snapshots', async () => {
	const legacyRecord = JSON.stringify({
		id: 1,
		time: '2026-01-01T00:00:00.000Z',
		kind: 'turn',
		title: '扩展旧快照',
		files: { [chapter]: '0'.repeat(64) },
		changes: [{ path: chapter, after: '0'.repeat(64) }],
	});
	await withApp(
		async ({ app, page, book, snapshotDir, original }) => {
			const settingsOpened = waitForSettingsPage(app);
			await page.evaluate(() => window.novel.settings.open());
			const settingsPage = await settingsOpened;
			await settingsPage.waitForLoadState('domcontentloaded');

			expect(await page.evaluate(() => window.novel.assistant.history())).toHaveLength(0);

			const editor = page.locator('.writing .cm-content');
			await editor.click();
			await page.keyboard.press('Meta+ArrowDown');
			await page.keyboard.insertText('关窗前手写稿。');
			await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(original + '关窗前手写稿。');

			const closed = page.waitForEvent('close');
			await page.evaluate(() => window.novel.window.close());
			await closed;

			const reopened = waitForContentPage(app);
			await settingsPage.evaluate((dir) => window.novel.book.open(dir), book);
			const nextPage = await reopened;
			await nextPage.waitForLoadState('domcontentloaded');

			await nextPage.getByRole('button', { name: '快照', exact: true }).click();
			await expect(nextPage.getByRole('dialog', { name: '快照', exact: true })).toContainText('定时 · 1 个文件');
			await expect(nextPage.getByRole('dialog', { name: '快照', exact: true })).not.toContainText('扩展旧快照');
			const records = await nextPage.evaluate(() => window.novel.assistant.history());
			expect(records).toHaveLength(1);
			expect(records[0]?.kind).toBe('timed');
			expect(Object.keys(records[0]?.files ?? {}).some((file) => file.startsWith('.novel-helper/snapshots'))).toBe(false);
			expect(JSON.parse(await readFile(join(snapshotDir, 'book.json'), 'utf8'))).toEqual({ root: await realpath(book) });
			expect(existsSync(join(snapshotDir, 'timed.json'))).toBe(true);
			expect(await readFile(join(book, '.novel-helper/snapshots/turns/000001.json'), 'utf8')).toBe(legacyRecord);
		},
		async (book) => {
			await mkdir(join(book, '.novel-helper/snapshots/turns'), { recursive: true });
			await writeFile(join(book, '.novel-helper/snapshots/turns/000001.json'), legacyRecord);
		},
	);
});

test('timed snapshot failure surfaces a top notice once without failing save or rename', async () => {
	await withApp(async ({ page, snapshotDir, original }) => {
		await page.evaluate(() => window.novel.settings.set('snapshots.intervalMinutes', 0.01));
		await mkdir(join(snapshotDir, 'timed.json'), { recursive: true });
		await page.waitForTimeout(700);

		const saveResult = await page.evaluate(({ file, text, base }) => window.novel.book.save(file, text, base), {
			file: chapter,
			text: original + '快照坏了也能保存。',
			base: original,
		});
		expect(saveResult).toEqual({ saved: true });
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '定时快照没存上：' })).toBeVisible();

		await page.locator('.notice[role="alert"] button').click();
		const renameResult = await page.evaluate(
			(file) => window.novel.structure.create({ action: 'rename', path: file, name: '新灯塔' }),
			chapter,
		);
		expect(Boolean('renames' in renameResult && renameResult.renames?.length)).toBe(true);
		await page.waitForTimeout(150);
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '定时快照没存上：' })).toHaveCount(0);
	});
});
