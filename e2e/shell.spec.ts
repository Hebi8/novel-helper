import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { resolveUserDataPath } from '../src/main/window/paths';
import { firstContentPage, sendCommand, waitForContentPage } from './helpers';

const chapter1 = '正文/第一卷 雾港/第一幕 来信/第1章 雾里来信.md';
const chapter2 = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';

function cleanEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
}

test('hebi8L branding, Novel Helper userData, lossless project.json book title, welcome titles, and hover +卷/+章', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-shell-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const cloudBooksDir = join(icloud, 'com~apple~CloudDocs/hebi8L');
	const cloudBook = join(cloudBooksDir, 'cloud-folder');
	const localBook = join(root, 'fog-harbor');
	const data = join(root, 'data');

	await mkdir(cloudBooksDir, { recursive: true });
	await cp(resolve('examples'), cloudBook, { recursive: true });
	await cp(resolve('examples'), localBook, { recursive: true });
	await mkdir(data, { recursive: true });

	const cloudMarkerPath = join(cloudBook, '.novel-helper/project.json');
	const cloudMarkerRaw = await readFile(cloudMarkerPath, 'utf8');
	await writeFile(cloudMarkerPath, cloudMarkerRaw.replace('"book": "全书"', '"book": "全书",\n  "title": "北境来信"'));

	const localMarkerPath = join(localBook, '.novel-helper/project.json');
	const originalLocalMarker = await readFile(localMarkerPath, 'utf8');

	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [], recent: [localBook], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		const welcome = await firstContentPage(app);
		await expect(welcome.getByRole('heading', { name: 'hebi8L', exact: true })).toBeVisible();
		await expect(welcome).toHaveTitle('hebi8L');

		const appMeta = await app.evaluate(({ app, Menu }) => {
			const menu = Menu.getApplicationMenu()!;
			const appSub = menu.items[0]?.submenu?.items.map((item) => item.label).filter(Boolean) ?? [];
			const fileSub = menu.items[1]?.submenu?.items.map((item) => item.label).filter(Boolean) ?? [];
			const helpSub =
				menu.items
					.at(-1)
					?.submenu?.items.map((item) => item.label)
					.filter(Boolean) ?? [];
			return {
				name: app.getName(),
				appData: app.getPath('appData'),
				firstMenu: menu.items[0]?.label,
				appSub,
				fileSub,
				helpSub,
			};
		});
		expect(appMeta.name).toBe('hebi8L');
		expect(basename(resolveUserDataPath(appMeta.appData, ['electron', 'dist/main/index.js']))).toBe('Novel Helper');
		expect(appMeta.firstMenu).toBe('hebi8L');
		expect(appMeta.appSub).toEqual(expect.arrayContaining(['关于 hebi8L', '退出 hebi8L']));
		expect(appMeta.fileSub).toContain('重命名书…');
		expect(appMeta.helpSub).toContain('hebi8L 帮助');
		await expect(
			welcome.getByRole('region', { name: '最近打开', exact: true }).getByRole('button', { name: 'fog-harbor', exact: true }),
		).toBeVisible();
		await expect(
			welcome.getByRole('region', { name: 'iCloud 里的书', exact: true }).getByRole('button', { name: '北境来信', exact: true }),
		).toBeVisible();

		const nextWin = waitForContentPage(app);
		await welcome.getByRole('region', { name: '最近打开', exact: true }).getByRole('button', { name: 'fog-harbor', exact: true }).click();
		const page = await nextWin;
		await page.waitForLoadState('domcontentloaded');

		// Top bar no longer has the ＋ new chapter button.
		await expect(page.locator('.topbar').getByRole('button', { name: '新建章' })).toHaveCount(0);
		await expect(page).toHaveTitle('fog-harbor');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('fog-harbor');

		const chapterTree = page.getByRole('tree', { name: '章节', exact: true });
		const bookRow = chapterTree.locator('.book-row');
		await expect(bookRow.locator('.tree-name')).toHaveText('fog-harbor');

		// Double-click book row: empty name rejected, Escape cancels without modifying project.json.
		await bookRow.locator('.tree-name').dblclick();
		const titleInput = bookRow.getByRole('textbox', { name: '重命名书…', exact: true });
		await expect(titleInput).toHaveValue('fog-harbor');
		await titleInput.fill('   ');
		await titleInput.press('Enter');
		await expect(titleInput).toBeVisible();
		expect(await readFile(localMarkerPath, 'utf8')).toBe(originalLocalMarker);
		await titleInput.press('Escape');
		await expect(titleInput).toHaveCount(0);
		await expect(bookRow.locator('.tree-name')).toHaveText('fog-harbor');

		// Double-click book row and confirm new title: project.json only adds title, other fields byte-for-byte intact.
		await bookRow.locator('.tree-name').dblclick();
		await titleInput.fill('雾港纪事');
		await titleInput.press('Enter');
		await expect(bookRow.locator('.tree-name')).toHaveText('雾港纪事');
		await expect(page.locator('.topbar strong')).toHaveText('雾港纪事');
		await expect(page).toHaveTitle('雾港纪事');
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('雾港纪事');
		const afterFirstRename = await readFile(localMarkerPath, 'utf8');
		expect(afterFirstRename.replace(',\n  "title": "雾港纪事"', '')).toBe(originalLocalMarker);
		expect(existsSync(localBook)).toBe(true);

		// Outline tree still uses 全书.
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '大纲', exact: true }).click();
		await expect(page.getByRole('tree', { name: '大纲', exact: true }).getByRole('button', { name: '全书', exact: true })).toBeVisible();

		// File → 重命名书… switches back to 章节 and edits title in place.
		await sendCommand(app, 'renameBook');
		await expect(titleInput).toHaveValue('雾港纪事');
		await titleInput.fill('雾港终章');
		await titleInput.press('Enter');
		await expect(bookRow.locator('.tree-name')).toHaveText('雾港终章');
		const afterSecondRename = await readFile(localMarkerPath, 'utf8');
		expect(afterSecondRename.replace(',\n  "title": "雾港终章"', '')).toBe(originalLocalMarker);

		// Hover actions on book row (＋卷, ＋章, ⋯) and volume row (＋章, ⋯) create items in exact positions.
		const addVolumeBtn = bookRow.getByRole('button', { name: '＋卷', exact: true });
		const addChapterBtn = bookRow.getByRole('button', { name: '＋章', exact: true });
		await expect(addVolumeBtn).toBeHidden();
		await bookRow.hover();
		await expect(addVolumeBtn).toBeVisible();
		await expect(addChapterBtn).toBeVisible();

		await addChapterBtn.click();
		const rootChapDialog = page.getByRole('dialog', { name: '新建章', exact: true });
		await rootChapDialog.getByRole('textbox', { name: '名字', exact: true }).fill('第3章 港外');
		await rootChapDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', '正文/第3章 港外.md');
		expect(existsSync(join(localBook, '正文/第3章 港外.md'))).toBe(true);

		await bookRow.hover();
		await addVolumeBtn.click();
		const volDialog = page.getByRole('dialog', { name: '新建卷', exact: true });
		await volDialog.getByRole('textbox', { name: '名字', exact: true }).fill('第二卷 北角');
		await volDialog.getByRole('textbox', { name: '第一章的名字', exact: true }).fill('第4章 启航');
		await volDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', '正文/第二卷 北角/第4章 启航.md');
		expect(existsSync(join(localBook, '正文/第二卷 北角/第4章 启航.md'))).toBe(true);

		const vol2Row = chapterTree.locator('.tree-row').filter({ has: page.getByRole('button', { name: '第二卷 北角', exact: true }) });
		await vol2Row.hover();
		await expect(vol2Row.getByRole('button', { name: '＋卷', exact: true })).toHaveCount(0);
		await vol2Row.getByRole('button', { name: '＋章', exact: true }).click();
		const volChapDialog = page.getByRole('dialog', { name: '新建章', exact: true });
		await volChapDialog.getByRole('textbox', { name: '名字', exact: true }).fill('第5章 靠岸');
		await volChapDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', '正文/第二卷 北角/第5章 靠岸.md');
		expect(existsSync(join(localBook, '正文/第二卷 北角/第5章 靠岸.md'))).toBe(true);
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('moves chapters, volumes and lore entries to Trash via shell.trashItem, closes tabs, and blocks when assistant is running', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-trash-e2e-')));
	const book = join(root, 'book');
	const data = join(root, 'data');
	const trash = join(root, 'trash');

	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data, { recursive: true });
	await mkdir(trash, { recursive: true });

	// Give Chapter 2 a summary as well so it has chapter + outline + summary + buoy record.
	const summary2 = '摘要/第2章 灯塔.md';
	await writeFile(join(book, summary2), '林小满在周伯旧屋前遇上陆青。\n');

	// Also give Chapter 1 a buoy record so Volume 1 still has buoy records after Chapter 2 is trashed.
	const buoy1 = `.novel-helper/buoys/${chapter1}.json`;
	await mkdir(join(book, '.novel-helper/buoys/正文/第一卷 雾港/第一幕 来信'), { recursive: true });
	await writeFile(
		join(book, buoy1),
		await readFile(join(book, `.novel-helper/buoys/${chapter2}.json`), 'utf8').then((text) => text.replace(chapter2, chapter1)),
	);

	await writeFile(
		join(data, 'windows.json'),
		JSON.stringify({
			open: [book],
			recent: [book],
			books: { [book]: { tabs: [{ path: chapter2, anchor: 0, head: 0 }], active: chapter2 } },
		}),
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			enabled: false,
			'snapshots.intervalMinutes': 0,
			'assistant.agent': 'custom',
			'assistant.command': process.execPath,
			'assistant.args': ['--experimental-strip-types', resolve('src/test/fakeAgent.ts'), '--resume', '--close'],
		}),
	);

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		await app.evaluate(({ shell }, trashDir) => {
			const fs = process.getBuiltinModule('node:fs/promises')!;
			const path = process.getBuiltinModule('node:path')!;
			const state = globalThis as typeof globalThis & {
				trashedPaths?: string[];
				trashSeq?: number;
				clearTrashed?: () => void;
			};
			state.trashedPaths = [];
			state.trashSeq = 0;
			state.clearTrashed = () => {
				state.trashedPaths = [];
			};
			shell.trashItem = async (fullPath: string) => {
				state.trashedPaths!.push(fullPath);
				state.trashSeq = (state.trashSeq ?? 0) + 1;
				await fs.rename(fullPath, path.join(trashDir, `${state.trashSeq}-${path.basename(fullPath)}`));
			};
		}, trash);
		const trashedRel = async () => {
			const list = await app!.evaluate(() => (globalThis as typeof globalThis & { trashedPaths?: string[] }).trashedPaths ?? []);
			return list.map((full) => full.slice(book.length + 1));
		};
		const clearTrashed = () => app!.evaluate(() => (globalThis as { clearTrashed?: () => void }).clearTrashed?.());

		const page = await firstContentPage(app);
		await page.waitForLoadState('domcontentloaded');
		const editor = page.locator('.editor:visible .cm-content');
		await expect(editor).toContainText('林小满');

		// Type unsaved text in Chapter 2 to verify saveAll runs before moving to Trash.
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('新增结尾。');

		const chapterTree = page.getByRole('tree', { name: '章节', exact: true });
		const chap2Row = chapterTree.locator('.tree-row').filter({ has: page.getByRole('button', { name: '第2章 灯塔', exact: true }) });

		// 1. Assistant running a turn blocks Move to Trash.
		await page.locator('.sidebar.right .segments').getByRole('button', { name: '助手', exact: true }).click();
		await page.getByRole('textbox', { name: '给助手的消息' }).fill('wait');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();

		await chap2Row.hover();
		await chap2Row.getByRole('button', { name: '⋯', exact: true }).click();
		await page.getByRole('menuitem', { name: '移到废纸篓…', exact: true }).click();
		const busyDialog = page.getByRole('dialog', { name: '把「第2章 灯塔」移到废纸篓？', exact: true });
		await expect(busyDialog).toContainText('可以在访达的废纸篓里放回。');
		await busyDialog.getByRole('button', { name: '移到废纸篓', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '助手正在处理这本书' })).toBeVisible();
		expect(await trashedRel()).toEqual([]);
		expect(existsSync(join(book, chapter2))).toBe(true);

		await page.getByRole('button', { name: '停止', exact: true }).click();
		await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 2. Delete Chapter 2: chapter, outline, summary and buoy record all go to trashItem, tab closes, tree updates.
		await chap2Row.hover();
		await chap2Row.getByRole('button', { name: '⋯', exact: true }).click();
		await page.getByRole('menuitem', { name: '移到废纸篓…', exact: true }).click();
		const chapDialog = page.getByRole('dialog', { name: '把「第2章 灯塔」移到废纸篓？', exact: true });
		await expect(chapDialog).toContainText('共 381 字。');
		await expect(chapDialog).toContainText('1 份大纲、1 份摘要');
		await expect(chapDialog).toContainText('浮标记录');
		await expect(chapDialog).toContainText('可以在访达的废纸篓里放回。');
		await chapDialog.getByRole('button', { name: '移到废纸篓', exact: true }).click();

		await expect(chapterTree.getByRole('button', { name: '第2章 灯塔', exact: true })).toHaveCount(0);
		await expect(page.locator('.tabs [role="tab"]')).toHaveCount(0);
		const chap2Expected = [chapter2, chapter2.replace('正文/', '大纲/'), summary2, `.novel-helper/buoys/${chapter2}.json`];
		expect((await trashedRel()).sort()).toEqual([...chap2Expected].sort());
		for (const rel of chap2Expected) {
			expect(existsSync(join(book, rel))).toBe(false);
		}
		expect(await readFile(join(trash, '1-第2章 灯塔.md'), 'utf8')).toContain('新增结尾。');

		// 3. Delete Volume 1: volume folder, outlines, shallow summary and buoy folder go to trashItem, open tab closes, tree updates.
		await clearTrashed();
		await chapterTree.getByRole('button', { name: '第1章 雾里来信', exact: true }).click();
		await expect(page.locator('.tabs [role="tab"]')).toHaveCount(1);

		const volRow = chapterTree.locator('.tree-row').filter({ has: page.getByRole('button', { name: '第一卷 雾港', exact: true }) });
		await volRow.hover();
		await volRow.getByRole('button', { name: '⋯', exact: true }).click();
		await page.getByRole('menuitem', { name: '移到废纸篓…', exact: true }).click();
		const volDialog = page.getByRole('dialog', { name: '把「第一卷 雾港」移到废纸篓？', exact: true });
		await expect(volDialog).toContainText('里面的 1 幕、1 章一起移走，共 394 字。');
		await expect(volDialog).toContainText('3 份大纲、1 份摘要');
		await expect(volDialog).toContainText('浮标记录');
		await expect(volDialog).toContainText('可以在访达的废纸篓里放回。');
		await volDialog.getByRole('button', { name: '移到废纸篓', exact: true }).click();

		await expect(chapterTree.getByRole('button', { name: '第一卷 雾港', exact: true })).toHaveCount(0);
		await expect(page.locator('.tabs [role="tab"]')).toHaveCount(0);
		const volExpected = [
			'正文/第一卷 雾港',
			'大纲/第一卷 雾港.md',
			'大纲/第一卷 雾港',
			'摘要/第1章 雾里来信.md',
			'.novel-helper/buoys/正文/第一卷 雾港',
		];
		expect((await trashedRel()).sort()).toEqual([...volExpected].sort());
		for (const rel of volExpected) {
			expect(existsSync(join(book, rel))).toBe(false);
		}
		expect(existsSync(join(book, '大纲/全书.md'))).toBe(true);

		// 4. Lore entry ⋯ menu: rename and Move to Trash.
		await clearTrashed();
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '设定', exact: true }).click();
		const loreTree = page.getByRole('tree', { name: '设定', exact: true });
		const linRow = loreTree.locator('.lore-row').filter({ hasText: '林小满' });
		await linRow.click();
		await expect(page.locator('.tabs [role="tab"]')).toContainText('林小满');

		await linRow.hover();
		await linRow.getByRole('button', { name: '⋯', exact: true }).click();
		await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
		const renameLoreDialog = page.getByRole('dialog', { name: '重命名', exact: true });
		await renameLoreDialog.getByRole('textbox', { name: '名字', exact: true }).fill('林小满改');
		await renameLoreDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.tabs [role="tab"]')).toContainText('林小满改');
		expect(existsSync(join(book, '人物/林小满改.md'))).toBe(true);

		const renamedLinRow = loreTree.locator('.lore-row').filter({ hasText: '林小满改' });
		await renamedLinRow.hover();
		await renamedLinRow.getByRole('button', { name: '⋯', exact: true }).click();
		await page.getByRole('menuitem', { name: '移到废纸篓…', exact: true }).click();
		const loreTrashDialog = page.getByRole('dialog', { name: '把「林小满改」移到废纸篓？', exact: true });
		await expect(loreTrashDialog).toContainText('可以在访达的废纸篓里放回。');
		await loreTrashDialog.getByRole('button', { name: '移到废纸篓', exact: true }).click();

		await expect(loreTree.locator('.lore-row').filter({ hasText: '林小满改' })).toHaveCount(0);
		await expect(page.locator('.tabs [role="tab"]')).toHaveCount(0);
		expect(await trashedRel()).toEqual(['人物/林小满改.md']);
		expect(existsSync(join(book, '人物/林小满改.md'))).toBe(false);
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('single confirmation dialog rule and blocking overlay lock shortcuts and typing during Move to Trash', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-trash-lock-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const book = join(root, 'book');
	const data = join(root, 'data');
	const trash = join(root, 'trash');

	await mkdir(join(icloud, 'com~apple~CloudDocs'), { recursive: true });
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data, { recursive: true });
	await mkdir(trash, { recursive: true });

	const originalChap1 = await readFile(join(book, chapter1), 'utf8');
	const originalChap2 = await readFile(join(book, chapter2), 'utf8');

	await writeFile(
		join(data, 'windows.json'),
		JSON.stringify({
			open: [book],
			recent: [book],
			books: {
				[book]: {
					tabs: [
						{ path: chapter1, anchor: 0, head: 0 },
						{ path: chapter2, anchor: 0, head: 0 },
					],
					active: chapter2,
				},
			},
		}),
	);
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		const page = await firstContentPage(app);
		await page.waitForLoadState('domcontentloaded');
		const chap2Editor = page.locator(`.cm-content[aria-label="${chapter2}"]`);
		const chap1Editor = page.locator(`.cm-content[aria-label="${chapter1}"]`);
		await expect(chap2Editor).toContainText('林小满');
		await expect(page.locator('.topbar button.topbar-book')).toBeEnabled();

		// Open Trash confirmation dialog, then trigger Save to iCloud from menu -> no second dialog opens.
		const chapterTree = page.getByRole('tree', { name: '章节', exact: true });
		const chap2Row = chapterTree.locator('.tree-row').filter({ has: page.getByRole('button', { name: '第2章 灯塔', exact: true }) });
		await chap2Row.hover();
		await chap2Row.getByRole('button', { name: '⋯', exact: true }).click();
		await page.getByRole('menuitem', { name: '移到废纸篓…', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: '把「第2章 灯塔」移到废纸篓？', exact: true });
		await expect(dialog).toBeVisible();
		await expect(page.locator('.topbar button.topbar-book')).toBeDisabled();

		await sendCommand(app, 'saveToICloud');
		await sendCommand(app, 'newChapter');
		await expect(page.getByRole('dialog', { name: '存到 iCloud', exact: true })).toHaveCount(0);
		await expect(page.getByRole('dialog', { name: '新建章', exact: true })).toHaveCount(0);
		await expect(page.getByRole('dialog')).toHaveCount(1);
		await expect(dialog).toBeVisible();

		await app.evaluate(({ shell }, trashDir) => {
			const fs = process.getBuiltinModule('node:fs/promises')!;
			const path = process.getBuiltinModule('node:path')!;
			const state = globalThis as typeof globalThis & {
				trashPaused?: boolean;
				releaseTrash?: () => void;
				trashSeq?: number;
			};
			state.trashPaused = false;
			state.trashSeq = 0;
			const gate = new Promise<void>((resolve) => {
				state.releaseTrash = resolve;
			});
			shell.trashItem = async (fullPath: string) => {
				if (!state.trashPaused) {
					state.trashPaused = true;
					await gate;
				}
				state.trashSeq = (state.trashSeq ?? 0) + 1;
				await fs.rename(fullPath, path.join(trashDir, `${state.trashSeq}-${path.basename(fullPath)}`));
			};
		}, trash);

		await dialog.getByRole('button', { name: '移到废纸篓', exact: true }).click();
		await expect.poll(() => app!.evaluate(() => (globalThis as { trashPaused?: boolean }).trashPaused)).toBe(true);

		// Confirmation dialog is replaced by the full-window blocking overlay.
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('.icloud-saving-backdrop')).toHaveText('正在移到废纸篓…');

		// Attempt focus mode, tab switch, new chapter, and typing while Move to Trash is suspended.
		await page.keyboard.press('Control+Meta+f');
		await sendCommand(app, 'focus');
		await sendCommand(app, 'previousTab');
		await sendCommand(app, 'newChapter');
		await page.keyboard.type('BlockedTyping');
		await page.keyboard.insertText('挂起期间打字');

		await expect(page.locator('.app')).not.toHaveClass(/focus-mode/);
		await expect(page.getByRole('dialog', { name: '新建章', exact: true })).toHaveCount(0);
		expect(await chap2Editor.innerText()).not.toContain('BlockedTyping');
		expect(await chap2Editor.innerText()).not.toContain('挂起期间打字');
		expect(await readFile(join(book, chapter1), 'utf8')).toBe(originalChap1);
		expect(await readFile(join(book, chapter2), 'utf8')).toBe(originalChap2);

		// Release trashItem: Chapter 2 tab closes and surviving Chapter 1 editor remains untouched.
		await app.evaluate(() => (globalThis as { releaseTrash?: () => void }).releaseTrash?.());
		await expect(page.locator('.icloud-saving-backdrop')).toHaveCount(0);
		await expect(chap2Editor).toHaveCount(0);
		await expect(chap1Editor).toBeVisible();
		await expect(chap1Editor).not.toContainText('BlockedTyping');
		await expect(chap1Editor).not.toContainText('挂起期间打字');
		expect(await readFile(join(book, chapter1), 'utf8')).toBe(originalChap1);
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});
