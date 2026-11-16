import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const chapterOriginal = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const chapterCopy = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔 2.md';
const outlineOriginal = '大纲/第一卷 雾港.md';
const outlineCopy = '大纲/第一卷 雾港 2.md';
const loreOriginal = '人物/林小满.md';
const loreCopy = '人物/林小满 2.md';

async function withConflictBook(
	run: (fixture: {
		app: ElectronApplication;
		page: Page;
		root: string;
		book: string;
		trash: string;
		originalChapterText: string;
		trashed(): Promise<string[]>;
	}) => Promise<void>,
	setupBook?: (book: string, root: string) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), 'novel-conflicts-e2e-'));
	const icloud = join(root, 'icloud');
	const book = join(icloud, 'book');
	const data = join(root, 'data');
	const trash = join(root, 'trash');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	await mkdir(trash);

	const originalChapterText = await readFile(join(book, chapterOriginal), 'utf8');
	if (setupBook) {
		await setupBook(book, root);
	} else {
		await writeFile(join(book, chapterCopy), originalChapterText + '\n另一台 Mac 上的灯塔续段。\n');
		await writeFile(join(book, outlineCopy), '# 第一卷 雾港\n\n## 冲突副本大纲节点\n');
		await writeFile(join(book, loreCopy), '---\naliases: [冲突别名]\n---\n另一台 Mac 上的林小满。\n');
		// Number < 2 and .txt files must not count as conflict copies.
		await writeFile(join(book, '设定/雾港 1.md'), '编号为 1 的普通设定');
		await writeFile(join(book, '设定/草稿.txt'), '原 txt');
		await writeFile(join(book, '设定/草稿 2.txt'), '副本 txt');
	}

	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [], recent: [], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	const launchEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: launchEnv,
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((resolve) => app!.process().once('exit', () => resolve()));

		const welcome = await app.firstWindow();
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		await app.evaluate(({ shell }, trashDir) => {
			const fs = process.getBuiltinModule('node:fs/promises')!;
			const path = process.getBuiltinModule('node:path')!;
			const state = globalThis as typeof globalThis & { trashedPaths?: string[] };
			state.trashedPaths = [];
			shell.trashItem = async (fullPath: string) => {
				state.trashedPaths!.push(fullPath);
				await fs.rename(fullPath, path.join(trashDir, `${state.trashedPaths!.length}-${path.basename(fullPath)}`));
			};
		}, trash);
		const next = app.waitForEvent('window');
		await welcome.evaluate((target) => window.novel.book.open(target), book);
		const page = await next;
		await page.waitForLoadState('domcontentloaded');
		await run({
			app,
			page,
			root,
			book,
			trash,
			originalChapterText,
			trashed: () => app!.evaluate(() => (globalThis as typeof globalThis & { trashedPaths?: string[] }).trashedPaths ?? []),
		});
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
}

test('identifies .md conflict copies in iCloud books, validates hashes and >5MB limits, snapshots before replace, and trashes copies', async () => {
	await withConflictBook(async ({ app, page, root, book, trash, originalChapterText, trashed }) => {
		// Status bar shows exact count of .md conflict copies (>= 2 with original present).
		const statusButton = page.getByRole('button', { name: '有 3 个冲突副本', exact: true });
		await expect(statusButton).toBeVisible();

		// Chapters tree shows the conflict copy beneath the original chapter, without affecting numbering.
		const chapterTree = page.getByRole('tree', { name: '章节', exact: true });
		await expect(chapterTree.locator('.conflict-copy-row')).toContainText('第2章 灯塔 2');
		await expect(chapterTree.locator('.conflict-copy-row')).toContainText('冲突副本');
		const suggested = await page.evaluate((target) => window.novel.structure.suggest('chapter', target), chapterOriginal);
		expect(suggested.name).toBe('第3章 ');

		// Outlines tree shows the conflict copy under the merged folder+file outline node, without adding outline graph nodes.
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '大纲', exact: true }).click();
		const outlineTree = page.getByRole('tree', { name: '大纲', exact: true });
		await expect(outlineTree.locator('.conflict-copy-row')).toContainText('第一卷 雾港 2');
		await expect(outlineTree.locator('.conflict-copy-row')).toContainText('冲突副本');
		await expect(page.getByRole('tree', { name: '看大纲', exact: true })).not.toContainText('冲突副本大纲节点');

		// Lore tree shows the conflict copy under the original entry, without indexing its aliases.
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '设定', exact: true }).click();
		const loreTree = page.getByRole('tree', { name: '设定', exact: true });
		await expect(loreTree.locator('.conflict-copy-row')).toContainText('林小满 2');
		await expect(loreTree.locator('.conflict-copy-row')).toContainText('冲突副本');
		await page.locator('.sidebar.right .segments').getByRole('button', { name: '看设定', exact: true }).click();
		await page.getByRole('textbox', { name: '查找名字或别名', exact: true }).fill('冲突别名');
		await expect(page.locator('.sidebar.right .sidebar-panel:visible .reference-list button')).toHaveCount(0);

		// Open original chapter and create an unresolved conflict in the editor -> replacing refuses and explains why.
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '章节', exact: true }).click();
		await chapterTree.getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const activeEditor = page.locator('.editor:visible .cm-content');
		await expect(activeEditor).toContainText('林小满');
		await activeEditor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('本地未存的字。');
		await writeFile(join(book, chapterOriginal), originalChapterText + '外部插进来的改动。');
		await expect(page.getByRole('button', { name: '留我的', exact: true })).toBeVisible();

		await statusButton.click();
		const diffDialog = page.getByRole('dialog', { name: `看差异 · ${chapterCopy}`, exact: true });
		await expect(diffDialog).toBeVisible();
		await diffDialog.getByRole('button', { name: '用副本替换原文', exact: true }).click();
		await page.getByRole('dialog', { name: '用副本替换原文', exact: true }).getByRole('button', { name: '确认替换', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '尚未解决的冲突' })).toBeVisible();
		expect(existsSync(join(book, chapterCopy))).toBe(true);
		expect(await trashed()).toHaveLength(0);

		// Resolve editor conflict by keeping disk version so the editor is clean again.
		await page.getByRole('button', { name: '用磁盘的', exact: true }).click();
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// Open diff, modify original externally while diff is open -> refuses with '文件刚被改过' and refreshes the diff in place.
		const copyText = await readFile(join(book, chapterCopy), 'utf8');
		await statusButton.click();
		await expect(diffDialog).toContainText('另一台 Mac 上的灯塔续段。');
		const updatedOriginalDisk = originalChapterText + '差异打开期间 iCloud 同步进来的新文字。';
		await writeFile(join(book, chapterOriginal), updatedOriginalDisk);
		await expect(activeEditor).toContainText('差异打开期间 iCloud 同步进来的新文字。');

		await diffDialog.getByRole('button', { name: '用副本替换原文', exact: true }).click();
		await page.getByRole('dialog', { name: '用副本替换原文', exact: true }).getByRole('button', { name: '确认替换', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '文件刚被改过' })).toBeVisible();
		await expect(diffDialog).toContainText('差异打开期间 iCloud 同步进来的新文字。');
		expect(await readFile(join(book, chapterOriginal), 'utf8')).toBe(updatedOriginalDisk);
		expect(existsSync(join(book, chapterCopy))).toBe(true);

		// Confirm replacement again from the refreshed diff -> now succeeds with updated hash.
		await diffDialog.getByRole('button', { name: '用副本替换原文', exact: true }).click();
		await page.getByRole('dialog', { name: '用副本替换原文', exact: true }).getByRole('button', { name: '确认替换', exact: true }).click();

		await expect.poll(() => readFile(join(book, chapterOriginal), 'utf8')).toBe(copyText);
		await expect(activeEditor).toContainText('另一台 Mac 上的灯塔续段。');
		expect(existsSync(join(book, chapterCopy))).toBe(false);
		expect((await trashed()).map((item) => basename(item))).toEqual(['第2章 灯塔 2.md']);
		expect(existsSync(join(trash, '1-第2章 灯塔 2.md'))).toBe(true);
		await expect(page.getByRole('button', { name: '有 2 个冲突副本', exact: true })).toBeVisible();

		// Snapshot was saved before replacement even with timed interval = 0, and reverting restores pre-replacement original.
		await page.getByRole('button', { name: '快照', exact: true }).click();
		const snapshotsDialog = page.getByRole('dialog', { name: '快照', exact: true });
		await expect(snapshotsDialog).toContainText(`冲突替换 · ${chapterOriginal}`);
		await snapshotsDialog.getByRole('button', { name: '退回到这个时间点', exact: true }).click();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();
		await expect.poll(() => readFile(join(book, chapterOriginal), 'utf8')).toBe(updatedOriginalDisk);
		await page.getByRole('button', { name: '快照', exact: true }).click();
		await page.getByRole('dialog', { name: '快照', exact: true }).getByRole('button', { name: '撤销这次退回', exact: true }).click();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();
		await expect.poll(() => readFile(join(book, chapterOriginal), 'utf8')).toBe(copyText);

		// Trash the second conflict copy (`大纲/第一卷 雾港 2.md`): external edit to copy blocks deletion and refreshes diff first.
		const originalOutlineText = await readFile(join(book, outlineOriginal), 'utf8');
		await page.getByRole('button', { name: '有 2 个冲突副本', exact: true }).click();
		const outlineDiff = page.getByRole('dialog', { name: `看差异 · ${outlineCopy}`, exact: true });
		await expect(outlineDiff).toBeVisible();
		await writeFile(join(book, outlineCopy), '# 第一卷 雾港\n\n## 刚从云端追进来的大纲副本\n');
		await outlineDiff.getByRole('button', { name: '删除副本', exact: true }).click();
		await page.getByRole('dialog', { name: '删除副本', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '文件刚被改过' })).toBeVisible();
		await expect(outlineDiff).toContainText('刚从云端追进来的大纲副本');
		expect(existsSync(join(book, outlineCopy))).toBe(true);

		await outlineDiff.getByRole('button', { name: '删除副本', exact: true }).click();
		await page.getByRole('dialog', { name: '删除副本', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();

		expect(existsSync(join(book, outlineCopy))).toBe(false);
		expect(await readFile(join(book, outlineOriginal), 'utf8')).toBe(originalOutlineText);
		await expect(page.getByRole('button', { name: '有 1 个冲突副本', exact: true })).toBeVisible();
		expect((await trashed()).map((item) => basename(item))).toEqual(['第2章 灯塔 2.md', '第一卷 雾港 2.md']);

		// Oversized original (> 5 MB) skipped by SnapshotStore refuses replacement and keeps both files.
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();
		const hugeLine = `${'雾'.repeat(1000)}\n`;
		const hugeBody = hugeLine.repeat(1750); // > 5.25 MB in UTF-8
		await writeFile(join(book, loreOriginal), `---\naliases: [小满]\n---\n${hugeBody}`);
		await writeFile(join(book, loreCopy), `---\naliases: [冲突别名]\n---\n${hugeBody}多一行\n`);
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '设定', exact: true }).click();
		await loreTree.locator('.conflict-copy-row').click();
		const hugeDiff = page.getByRole('dialog', { name: `看差异 · ${loreCopy}`, exact: true });
		await expect(hugeDiff).toBeVisible();
		await hugeDiff.getByRole('button', { name: '用副本替换原文', exact: true }).click();
		await page.getByRole('dialog', { name: '用副本替换原文', exact: true }).getByRole('button', { name: '确认替换', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '原文太大或无法存快照，不替换' })).toBeVisible();
		expect(existsSync(join(book, loreCopy))).toBe(true);
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// Restore normal-sized loreOriginal; unsaved edit in loreOriginal blocks trashing loreCopy before autosave flushes.
		await writeFile(join(book, loreOriginal), '---\naliases: [小满]\n---\n林小满每天天不亮就出门。\n');
		await loreTree.locator('.lore-row:not(.conflict-copy-row)').filter({ hasText: '林小满' }).click();
		await expect(activeEditor).toContainText('林小满每天天不亮就出门');
		await activeEditor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('刚打但还没满一秒保存。');
		await loreTree.locator('.conflict-copy-row').click();
		const loreDiff = page.getByRole('dialog', { name: `看差异 · ${loreCopy}`, exact: true });
		await loreDiff.getByRole('button', { name: '删除副本', exact: true }).click();
		await page.getByRole('dialog', { name: '删除副本', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '未保存内容' })).toBeVisible();
		expect(existsSync(join(book, loreCopy))).toBe(true);
		await expect.poll(() => readFile(join(book, loreOriginal), 'utf8')).toContain('刚打但还没满一秒保存。');

		// Move the remaining lore conflict copy away -> status bar conflict indicator disappears completely.
		await rename(join(book, loreCopy), join(trash, 'manual-lore-copy.md'));
		await expect(page.locator('.status-conflict')).toHaveCount(0);

		// A local book outside `--icloud-dir` treats `<name> 2.md` next to `<name>.md` as an ordinary chapter.
		const localBook = join(root, 'local-book');
		await cp(resolve('examples'), localBook, { recursive: true });
		await writeFile(join(localBook, chapterCopy), '本地书里合法的第2章 灯塔 2');
		const nextLocal = app.waitForEvent('window');
		await page.evaluate((target) => window.novel.book.open(target), localBook);
		const localPage = await nextLocal;
		await localPage.waitForLoadState('domcontentloaded');
		await expect(
			localPage.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔 2', exact: true }),
		).toBeVisible();
		await expect(localPage.locator('.conflict-copy-row')).toHaveCount(0);
		await expect(localPage.locator('.status-conflict')).toHaveCount(0);
	});
});

test('ignores .json conflict copies of project.json and buoy files when opening, moving buoys, and renaming chapters', async () => {
	const markerCopy = '.novel-helper/project 2.json';
	const buoyCopy = `.novel-helper/buoys/${chapterOriginal.slice(0, -'.md'.length)}.md 2.json`;
	await withConflictBook(
		async ({ page, book }) => {
			await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
			await expect(page.locator('.status-conflict')).toHaveCount(0);

			const chapterTree = page.getByRole('tree', { name: '章节', exact: true });
			await chapterTree.getByRole('button', { name: '第2章 灯塔', exact: true }).click();
			await expect(page.locator('.status-buoy')).toContainText('周伯收信');

			await page.getByRole('button', { name: '前进一格', exact: true }).click();
			await expect(page.locator('.status-buoy')).not.toContainText('周伯收信');

			await chapterTree.getByRole('button', { name: '第2章 灯塔', exact: true }).click({ button: 'right' });
			await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
			await dialog.getByRole('textbox', { name: '名字', exact: true }).fill('第2章 北角灯塔');
			await dialog.getByRole('button', { name: '确定', exact: true }).click();

			await expect(chapterTree.getByRole('button', { name: '第2章 北角灯塔', exact: true })).toBeVisible();
			await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
			expect(await readFile(join(book, markerCopy), 'utf8')).toBe('{corrupted-marker-copy');
			expect(await readFile(join(book, buoyCopy), 'utf8')).toBe('{corrupted-buoy-copy');
		},
		async (book) => {
			await writeFile(join(book, markerCopy), '{corrupted-marker-copy');
			await writeFile(join(book, buoyCopy), '{corrupted-buoy-copy');
		},
	);
});
