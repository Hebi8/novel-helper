import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';

async function listRelativeFiles(root: string, relative = ''): Promise<string[]> {
	const dir = relative ? join(root, relative) : root;
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await listRelativeFiles(root, child)));
		} else if (entry.isFile()) {
			files.push(child);
		}
	}
	return files.sort();
}

function cleanEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
}

async function fileMenuLabels(app: ElectronApplication): Promise<string[]> {
	return app.evaluate(({ Menu }) => {
		const fileItem = Menu.getApplicationMenu()?.items.find((item) => item.label === '文件');
		return fileItem?.submenu?.items.filter((item) => item.visible && item.label).map((item) => item.label) ?? [];
	});
}

async function saveMenuEnabled(app: ElectronApplication): Promise<boolean | undefined> {
	return app.evaluate(({ Menu }) => {
		const fileItem = Menu.getApplicationMenu()?.items.find((item) => item.label === '文件');
		return fileItem?.submenu?.items.find((item) => item.label === '存到 iCloud')?.enabled;
	});
}

test('hides all iCloud entry points when com~apple~CloudDocs does not exist', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-icloud-absent-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const localBook = join(root, '雾港');
	const data = join(root, 'data');
	await mkdir(icloud, { recursive: true });
	await cp(resolve('examples'), localBook, { recursive: true });
	await mkdir(data, { recursive: true });
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

		const welcome = await app.firstWindow();
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		await expect(welcome.getByRole('region', { name: '最近打开', exact: true })).toBeVisible();
		await expect(welcome.getByRole('heading', { name: 'iCloud 里的书', exact: true })).toHaveCount(0);
		expect(await fileMenuLabels(app)).not.toContain('存到 iCloud');

		const next = app.waitForEvent('window');
		await welcome.getByRole('region', { name: '最近打开', exact: true }).getByRole('button', { name: '雾港', exact: true }).click();
		const page = await next;
		await page.waitForLoadState('domcontentloaded');
		await expect(page.locator('.topbar strong')).toHaveText('雾港');
		await expect(page.locator('.topbar button.topbar-book')).toHaveCount(0);
		expect(await fileMenuLabels(app)).not.toContain('存到 iCloud');
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('saves a book to iCloud after checking conflicts, busy assistant, existing target, and mid-copy failure', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-icloud-save-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const drive = join(icloud, 'com~apple~CloudDocs');
	const booksDir = join(drive, 'hebi8L');
	const localBook = join(root, '雾港');
	const otherBook = join(root, '另一本书');
	const data = join(root, 'data');
	const trash = join(root, 'trash');

	await mkdir(drive, { recursive: true });
	await cp(resolve('examples'), localBook, { recursive: true });
	await cp(resolve('examples'), otherBook, { recursive: true });
	await mkdir(data, { recursive: true });
	await mkdir(trash, { recursive: true });

	// Add skipped directories (.git, node_modules, legacy .novel-helper/snapshots) to the local book.
	await mkdir(join(localBook, '.git'), { recursive: true });
	await writeFile(join(localBook, '.git/HEAD'), 'ref: refs/heads/main\n');
	await mkdir(join(localBook, 'node_modules/fake-pkg'), { recursive: true });
	await writeFile(join(localBook, 'node_modules/fake-pkg/index.js'), 'module.exports = {};\n');
	await mkdir(join(localBook, '.novel-helper/snapshots/turns'), { recursive: true });
	await writeFile(join(localBook, '.novel-helper/snapshots/turns/000001.json'), '{"id":1}\n');
	await mkdir(join(localBook, '.novel-helper/templates'), { recursive: true });
	await writeFile(join(localBook, '.novel-helper/templates/人物.md'), '---\ntype: 人物\n---\n');

	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [localBook], recent: [localBook, otherBook], books: {} }));
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
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

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
		const trashed = () => app!.evaluate(() => (globalThis as typeof globalThis & { trashedPaths?: string[] }).trashedPaths ?? []);

		const page = await app.firstWindow();
		await page.waitForLoadState('domcontentloaded');
		await expect(page.locator('.topbar strong')).toHaveText('雾港');
		expect(await fileMenuLabels(app)).toContain('存到 iCloud');

		const openSaveDialog = async () => {
			await page.locator('.topbar button.topbar-book').click();
			await page.getByRole('menuitem', { name: '存到 iCloud', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: '存到 iCloud', exact: true });
			await expect(dialog).toContainText('iCloud 云盘/hebi8L/雾港');
			await expect(dialog).toContainText('原来的文件夹保留不动');
			return dialog;
		};

		// 1. Cancel confirmation dialog does nothing.
		const cancelDialog = await openSaveDialog();
		await cancelDialog.getByRole('button', { name: '取消', exact: true }).click();
		await expect(cancelDialog).toHaveCount(0);
		expect(existsSync(join(booksDir, '雾港'))).toBe(false);

		// 2. Unresolved editor conflict blocks Save to iCloud.
		const originalChapter = await readFile(join(localBook, chapter), 'utf8');
		await page.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const editor = page.locator('.editor:visible .cm-content');
		await expect(editor).toContainText('林小满');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('未保存的本地改动。');
		await writeFile(join(localBook, chapter), originalChapter + '外部同时改写的内容。');
		await expect(page.getByRole('button', { name: '留我的', exact: true })).toBeVisible();

		const conflictDialog = await openSaveDialog();
		await conflictDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '冲突尚未解决' })).toBeVisible();
		expect(existsSync(join(booksDir, '雾港'))).toBe(false);

		// Resolve conflict by keeping disk version and restoring original chapter text.
		await page.getByRole('button', { name: '用磁盘的', exact: true }).click();
		await writeFile(join(localBook, chapter), originalChapter);
		await expect(editor).not.toContainText('外部同时改写的内容。');
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 3. Assistant running a turn blocks Save to iCloud.
		await page.locator('.sidebar.right .segments').getByRole('button', { name: '助手', exact: true }).click();
		await page.getByRole('textbox', { name: '给助手的消息' }).fill('wait');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();

		const busyDialog = await openSaveDialog();
		await busyDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]').filter({ hasText: '助手正在处理这本书' })).toBeVisible();
		expect(existsSync(join(booksDir, '雾港'))).toBe(false);

		await page.getByRole('button', { name: '停止', exact: true }).click();
		await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 4. Existing folder with the same name in Novel Helper/ blocks execution with exact message.
		await mkdir(join(booksDir, '雾港'), { recursive: true });
		await writeFile(join(booksDir, '雾港/placeholder.md'), '云端已有的同名书');
		const existsDialog = await openSaveDialog();
		await existsDialog.getByRole('button', { name: '确定', exact: true }).click();
		await expect(page.locator('.notice[role="alert"]')).toContainText('iCloud 里已有同名的书');
		expect(await readFile(join(booksDir, '雾港/placeholder.md'), 'utf8')).toBe('云端已有的同名书');
		expect(await trashed()).toHaveLength(0);
		await rm(join(booksDir, '雾港'), { recursive: true, force: true });
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 5. Mid-copy failure moves .partial to Trash and leaves original book untouched.
		const lockedDir = join(localBook, '资料');
		const lockedFile = join(lockedDir, 'unreadable.bin');
		await mkdir(lockedDir, { recursive: true });
		await writeFile(lockedFile, 'cannot-read');
		await chmod(lockedFile, 0o000);
		try {
			const failDialog = await openSaveDialog();
			await failDialog.getByRole('button', { name: '确定', exact: true }).click();
			await expect(page.locator('.notice[role="alert"]')).toBeVisible();
			expect((await trashed()).map((item) => basename(item))).toEqual(['雾港.partial']);
			expect(existsSync(join(booksDir, '雾港.partial'))).toBe(false);
			expect(existsSync(join(booksDir, '雾港'))).toBe(false);
			expect(existsSync(join(trash, '1-雾港.partial'))).toBe(true);
		} finally {
			await chmod(lockedFile, 0o644);
			await rm(lockedDir, { recursive: true, force: true });
		}
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 5b. While copying is in progress: overlay blocks editor & menu actions, repeated Save to iCloud does not revert state,
		// and a target folder created after the initial check is not overwritten while failure removes the overlay and restores editing.
		await app.evaluate(() => {
			const fs = process.getBuiltinModule('node:fs/promises')!;
			const realCopyFile = fs.copyFile.bind(fs);
			const state = globalThis as typeof globalThis & {
				copyPaused?: boolean;
				releaseCopy?: () => void;
				restoreCopy?: () => void;
			};
			state.copyPaused = false;
			const gate = new Promise<void>((resolve) => {
				state.releaseCopy = resolve;
			});
			fs.copyFile = (async (...args: Parameters<typeof fs.copyFile>) => {
				if (String(args[1]).includes('雾港.partial') && !state.copyPaused) {
					state.copyPaused = true;
					await gate;
				}
				return realCopyFile(...args);
			}) as typeof fs.copyFile;
			state.restoreCopy = () => {
				fs.copyFile = realCopyFile;
			};
		});
		try {
			const pausedDialog = await openSaveDialog();
			await pausedDialog.getByRole('button', { name: '确定', exact: true }).click();
			await expect.poll(() => app!.evaluate(() => (globalThis as { copyPaused?: boolean }).copyPaused)).toBe(true);

			// Confirmation dialog is gone; blocking overlay shows only '正在存到 iCloud…'; both entry points are disabled.
			await expect(page.getByRole('dialog', { name: '存到 iCloud', exact: true })).toHaveCount(0);
			await expect(page.locator('.icloud-saving-backdrop')).toHaveText('正在存到 iCloud…');
			await expect(page.locator('.topbar button.topbar-book')).toBeDisabled();
			expect(await saveMenuEnabled(app)).toBe(false);

			// Triggering Save to iCloud command again while running does not revert state to confirmation dialog.
			await app.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows()[0].webContents.send('window:command', 'saveToICloud');
				BrowserWindow.getAllWindows()[0].webContents.send('window:command', 'newChapter');
				BrowserWindow.getAllWindows()[0].webContents.send('window:command', 'closeTab');
				BrowserWindow.getAllWindows()[0].webContents.send('window:command', 'assistant:focus');
			});
			await expect(page.getByRole('dialog', { name: '存到 iCloud', exact: true })).toHaveCount(0);
			await expect(page.getByRole('dialog', { name: '新建章', exact: true })).toHaveCount(0);
			await expect(page.locator('.icloud-saving-backdrop')).toHaveText('正在存到 iCloud…');

			// Editor cannot be typed into while the overlay is up.
			await page.keyboard.insertText('遮罩期间不该写进去的字');
			await page.keyboard.type('BlockedText');
			await page.keyboard.press('Meta+n');
			await expect(page.getByRole('dialog', { name: '新建章', exact: true })).toHaveCount(0);
			await expect(editor).not.toContainText('遮罩期间不该写进去的字');
			await expect(editor).not.toContainText('BlockedText');
			expect(await readFile(join(localBook, chapter), 'utf8')).toBe(originalChapter);

			// Simulate iCloud creating an empty same-named folder after the initial pre-copy check; release copy -> refuses without overwriting it.
			await mkdir(join(booksDir, '雾港'));
			await app.evaluate(() => (globalThis as { releaseCopy?: () => void }).releaseCopy?.());

			await expect(page.locator('.icloud-saving-backdrop')).toHaveCount(0);
			await expect(page.locator('.notice[role="alert"]')).toContainText('iCloud 里已有同名的书');
			expect(await readdir(join(booksDir, '雾港'))).toEqual([]);
			expect(existsSync(join(booksDir, '雾港.partial'))).toBe(false);
			expect((await trashed()).map((item) => basename(item))).toEqual(['雾港.partial', '雾港.partial']);
			await expect(page.locator('.topbar button.topbar-book')).toBeEnabled();
			expect(await saveMenuEnabled(app)).toBe(true);
			await expect(editor).toBeFocused();
		} finally {
			await app.evaluate(() => (globalThis as { restoreCopy?: () => void }).restoreCopy?.());
			await rm(join(booksDir, '雾港'), { recursive: true, force: true });
		}
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();

		// 6. Snapshot all untouched files, type an edit (not yet autosaved after 1s), and immediately Save to iCloud.
		const beforeFiles = await listRelativeFiles(localBook);
		const beforeBytes = new Map<string, Buffer>();
		for (const file of beforeFiles) {
			beforeBytes.set(file, await readFile(join(localBook, file)));
		}

		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('存进 iCloud 前刚写下的一句。');

		const nextWindow = app.waitForEvent('window');
		const okDialog = await openSaveDialog();
		await okDialog.getByRole('button', { name: '确定', exact: true }).click();
		const icloudPage = await nextWindow;
		await icloudPage.waitForLoadState('domcontentloaded');

		// Old window closes; only the new iCloud book window remains.
		await expect.poll(() => app!.windows().length).toBe(1);

		const expectedTarget = join(booksDir, '雾港');
		expect(existsSync(join(booksDir, '雾港.partial'))).toBe(false);
		expect(existsSync(expectedTarget)).toBe(true);

		// Unsaved edit was flushed first; all other files in original book are untouched; iCloud copy matches byte-for-byte.
		expect(await readFile(join(localBook, chapter), 'utf8')).toBe(originalChapter + '存进 iCloud 前刚写下的一句。');
		const localFiles = await listRelativeFiles(localBook);
		expect(localFiles).toEqual(beforeFiles);
		for (const file of localFiles) {
			if (file !== chapter) {
				expect(await readFile(join(localBook, file))).toEqual(beforeBytes.get(file));
			}
		}
		const copiedFiles = await listRelativeFiles(expectedTarget);
		const expectedFiles = localFiles.filter(
			(file) => !file.startsWith('.git/') && !file.startsWith('node_modules/') && !file.startsWith('.novel-helper/snapshots/'),
		);
		expect(copiedFiles).toEqual(expectedFiles);
		expect(copiedFiles).toContain('.novel-helper/project.json');
		expect(copiedFiles.some((file) => file.startsWith('.novel-helper/buoys/'))).toBe(true);
		expect(copiedFiles.some((file) => file.startsWith('.novel-helper/templates/'))).toBe(true);
		for (const file of copiedFiles) {
			expect(await readFile(join(expectedTarget, file))).toEqual(await readFile(join(localBook, file)));
		}
		// Skipped folders still exist in original book, untouched.
		expect(existsSync(join(localBook, '.git/HEAD'))).toBe(true);
		expect(existsSync(join(localBook, 'node_modules/fake-pkg/index.js'))).toBe(true);
		expect(existsSync(join(localBook, '.novel-helper/snapshots/turns/000001.json'))).toBe(true);

		// New window is opened at the iCloud path, hides Save to iCloud in TopBar and File menu, and shows the one-time notice.
		await expect(icloudPage.locator('.topbar strong')).toHaveText('雾港');
		await expect(icloudPage.locator('.topbar button.topbar-book')).toHaveCount(0);
		expect(await fileMenuLabels(app)).not.toContain('存到 iCloud');

		const expectedNotice = `已存到 iCloud。原来的文件夹还在：${localBook}，以后请打开 iCloud 里的这一份`;
		await expect(icloudPage.locator('.notice[role="alert"]')).toContainText(expectedNotice);
		await icloudPage.getByRole('button', { name: '关闭提示', exact: true }).click();
		await expect(icloudPage.locator('.notice[role="alert"]')).toHaveCount(0);

		const bootstrap = await icloudPage.evaluate(() => window.novel.window.bootstrap());
		expect(bootstrap.book?.root).toBe(expectedTarget);
		expect(bootstrap.book?.inICloud).toBe(true);
		expect(bootstrap.notice).toBeUndefined();

		// Recent list replaced localBook with expectedTarget while keeping otherBook.
		await expect
			.poll(async () => JSON.parse(await readFile(join(data, 'windows.json'), 'utf8')) as { recent: string[]; open: string[] })
			.toEqual(expect.objectContaining({ recent: [expectedTarget, otherBook], open: [expectedTarget] }));
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('welcome page lists iCloud books without deduplicating recent, watches for newly synced books, and opens them', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-icloud-welcome-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const drive = join(icloud, 'com~apple~CloudDocs');
	const booksDir = join(drive, 'hebi8L');
	const firstBook = join(booksDir, '雾港');
	const syncedBook = join(booksDir, '北境来信');
	const stagingBook = join(root, 'staging-book');
	const data = join(root, 'data');

	await mkdir(drive, { recursive: true });
	await cp(resolve('examples'), stagingBook, { recursive: true });
	await mkdir(data, { recursive: true });
	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [], recent: [firstBook], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		const welcome = await app.firstWindow();
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();

		// Initially Novel Helper/ has no books -> iCloud section is hidden while Recent still shows firstBook.
		const recentSection = welcome.getByRole('region', { name: '最近打开', exact: true });
		await expect(recentSection.getByRole('button', { name: '雾港', exact: true })).toBeVisible();
		await expect(welcome.getByRole('region', { name: 'iCloud 里的书', exact: true })).toHaveCount(0);

		// Simulate iCloud syncing firstBook (already in Recent) and then syncedBook while Welcome is open.
		await mkdir(booksDir, { recursive: true });
		await cp(stagingBook, firstBook, { recursive: true });

		const icloudSection = welcome.getByRole('region', { name: 'iCloud 里的书', exact: true });
		await expect(icloudSection).toBeVisible();
		// Same book appears in both Recent and iCloud sections without deduplication.
		await expect(recentSection.getByRole('button', { name: '雾港', exact: true })).toBeVisible();
		await expect(icloudSection.getByRole('button', { name: '雾港', exact: true })).toBeVisible();

		// Newly synced book appears automatically while Welcome remains open (ignoring .partial until ready).
		await cp(stagingBook, `${syncedBook}.partial`, { recursive: true });
		await expect(icloudSection.getByRole('button', { name: /partial/ })).toHaveCount(0);
		await rename(`${syncedBook}.partial`, syncedBook);
		await expect(icloudSection.getByRole('button', { name: '北境来信', exact: true })).toBeVisible();

		// Clicking the synced book in iCloud 里的书 opens it directly.
		const next = app.waitForEvent('window');
		await icloudSection.getByRole('button', { name: '北境来信', exact: true }).click();
		const opened = await next;
		await opened.waitForLoadState('domcontentloaded');
		await expect(opened.locator('.topbar strong')).toHaveText('北境来信');
		await expect(opened.locator('.topbar button.topbar-book')).toHaveCount(0);
		await expect(opened.getByRole('tree', { name: '章节', exact: true })).toContainText('第2章 灯塔');
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('blocks window close while initial saveAll is pending during Save to iCloud and restores close flow on failure', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-icloud-close-gate-e2e-')));
	const icloud = join(root, 'Mobile Documents');
	const drive = join(icloud, 'com~apple~CloudDocs');
	const booksDir = join(drive, 'hebi8L');
	const localBook = join(root, '雾港');
	const otherBook = join(root, '另一本书');
	const data = join(root, 'data');

	await mkdir(booksDir, { recursive: true });
	await mkdir(join(booksDir, '雾港'), { recursive: true });
	await cp(resolve('examples'), localBook, { recursive: true });
	await cp(resolve('examples'), otherBook, { recursive: true });
	await mkdir(data, { recursive: true });
	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [localBook, otherBook], recent: [localBook, otherBook], books: {} }));
	await writeFile(join(data, 'settings.json'), JSON.stringify({ enabled: false, 'snapshots.intervalMinutes': 0 }));

	const originalChapter = await readFile(join(localBook, chapter), 'utf8');

	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	try {
		app = await electron.launch({
			env: cleanEnv(),
			args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`, `--icloud-dir=${icloud}`],
		});
		exited = new Promise((done) => app!.process().once('exit', () => done()));

		await expect.poll(() => app!.windows().length).toBe(2);
		const initialWindows = app.windows();
		for (const win of initialWindows) {
			await win.waitForLoadState('domcontentloaded');
			await expect(win.locator('.topbar strong')).toBeVisible();
		}
		const firstTitle = await initialWindows[0].locator('.topbar strong').textContent();
		const [page, otherPage] = firstTitle === '雾港' ? [initialWindows[0], initialWindows[1]] : [initialWindows[1], initialWindows[0]];

		// 1. On 雾港 (where migration will fail because booksDir/雾港 already exists):
		// hang initial saveAll(), send window close request -> window stays open -> release save -> text is on disk -> normal close flow works.
		await page.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const editor = page.locator('.editor:visible .cm-content');
		await expect(editor).toContainText('林小满');

		await app.evaluate(() => {
			const fs = process.getBuiltinModule('node:fs/promises')!;
			const realWriteFile = fs.writeFile.bind(fs);
			const state = globalThis as typeof globalThis & {
				writePaused?: boolean;
				releaseWrite?: () => void;
				restoreWrite?: () => void;
			};
			state.writePaused = false;
			const gate = new Promise<void>((resolve) => {
				state.releaseWrite = resolve;
			});
			fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
				if (String(args[0]).includes('第2章 灯塔.md.') && !state.writePaused) {
					state.writePaused = true;
					await gate;
				}
				return realWriteFile(...args);
			}) as typeof fs.writeFile;
			state.restoreWrite = () => {
				fs.writeFile = realWriteFile;
			};
		});

		try {
			await editor.click();
			await page.keyboard.press('Meta+ArrowDown');
			await page.keyboard.insertText('保存挂起期间不丢的字。');

			await page.locator('.topbar button.topbar-book').click();
			await page.getByRole('menuitem', { name: '存到 iCloud', exact: true }).click();
			await page.getByRole('dialog', { name: '存到 iCloud', exact: true }).getByRole('button', { name: '确定', exact: true }).click();

			await expect.poll(() => app!.evaluate(() => (globalThis as { writePaused?: boolean }).writePaused)).toBe(true);
			expect(await readFile(join(localBook, chapter), 'utf8')).toBe(originalChapter);

			// Request closing the window while saveAll() is still pending (before main process sets copying).
			await page.evaluate(() => window.novel.window.close());
			await page.waitForTimeout(150);
			expect(page.isClosed()).toBe(false);
			await expect(page.locator('.icloud-saving-backdrop')).toHaveText('正在存到 iCloud…');

			// Release saveAll(): text lands on disk, migration fails due to existing target, window remains open.
			await app.evaluate(() => (globalThis as { releaseWrite?: () => void }).releaseWrite?.());
			await expect(page.locator('.icloud-saving-backdrop')).toHaveCount(0);
			await expect(page.locator('.notice[role="alert"]')).toContainText('iCloud 里已有同名的书');
			expect(page.isClosed()).toBe(false);
			expect(await readFile(join(localBook, chapter), 'utf8')).toBe(originalChapter + '保存挂起期间不丢的字。');
		} finally {
			await app.evaluate(() => (globalThis as { restoreWrite?: () => void }).restoreWrite?.());
		}

		// Normal close flow is restored after migration failure: unsaved text is flushed and the window closes.
		await page.getByRole('button', { name: '关闭提示', exact: true }).click();
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('失败后关窗保存的字。');
		await page.evaluate(() => window.novel.window.close());
		await expect.poll(() => page.isClosed()).toBe(true);
		expect(await readFile(join(localBook, chapter), 'utf8')).toBe(originalChapter + '保存挂起期间不丢的字。失败后关窗保存的字。');

		// 2. On 另一本书 (where migration succeeds):
		// hang both saveAll() and copyFile(), send close request during saveAll() -> window stays open through both save and copy,
		// text is on disk once save completes, and old window closes only after migration finishes.
		await otherPage.getByRole('tree', { name: '章节', exact: true }).getByRole('button', { name: '第2章 灯塔', exact: true }).click();
		const otherEditor = otherPage.locator('.editor:visible .cm-content');
		await expect(otherEditor).toContainText('林小满');

		await app.evaluate(() => {
			const fs = process.getBuiltinModule('node:fs/promises')!;
			const realWriteFile = fs.writeFile.bind(fs);
			const realCopyFile = fs.copyFile.bind(fs);
			const state = globalThis as typeof globalThis & {
				writePaused2?: boolean;
				copyPaused2?: boolean;
				releaseWrite2?: () => void;
				releaseCopy2?: () => void;
				restoreFs2?: () => void;
			};
			state.writePaused2 = false;
			state.copyPaused2 = false;
			const writeGate = new Promise<void>((resolve) => {
				state.releaseWrite2 = resolve;
			});
			const copyGate = new Promise<void>((resolve) => {
				state.releaseCopy2 = resolve;
			});
			fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
				if (String(args[0]).includes('第2章 灯塔.md.') && !state.writePaused2) {
					state.writePaused2 = true;
					await writeGate;
				}
				return realWriteFile(...args);
			}) as typeof fs.writeFile;
			fs.copyFile = (async (...args: Parameters<typeof fs.copyFile>) => {
				if (String(args[1]).includes('另一本书.partial') && !state.copyPaused2) {
					state.copyPaused2 = true;
					await copyGate;
				}
				return realCopyFile(...args);
			}) as typeof fs.copyFile;
			state.restoreFs2 = () => {
				fs.writeFile = realWriteFile;
				fs.copyFile = realCopyFile;
			};
		});

		try {
			await otherEditor.click();
			await otherPage.keyboard.press('Meta+ArrowDown');
			await otherPage.keyboard.insertText('迁移完成才关窗的字。');

			const nextWindow = app.waitForEvent('window');
			await otherPage.locator('.topbar button.topbar-book').click();
			await otherPage.getByRole('menuitem', { name: '存到 iCloud', exact: true }).click();
			await otherPage.getByRole('dialog', { name: '存到 iCloud', exact: true }).getByRole('button', { name: '确定', exact: true }).click();

			await expect.poll(() => app!.evaluate(() => (globalThis as { writePaused2?: boolean }).writePaused2)).toBe(true);
			await otherPage.evaluate(() => window.novel.window.close());
			await otherPage.waitForTimeout(150);
			expect(otherPage.isClosed()).toBe(false);

			// Finish saveAll(): text is now on disk, migration is still copying -> window still must not close.
			await app.evaluate(() => (globalThis as { releaseWrite2?: () => void }).releaseWrite2?.());
			await expect.poll(() => app!.evaluate(() => (globalThis as { copyPaused2?: boolean }).copyPaused2)).toBe(true);
			expect(await readFile(join(otherBook, chapter), 'utf8')).toBe(originalChapter + '迁移完成才关窗的字。');
			expect(otherPage.isClosed()).toBe(false);

			// Finish migration: new iCloud window opens and old window closes.
			await app.evaluate(() => (globalThis as { releaseCopy2?: () => void }).releaseCopy2?.());
			const migratedPage = await nextWindow;
			await migratedPage.waitForLoadState('domcontentloaded');
			await expect(migratedPage.locator('.topbar strong')).toHaveText('另一本书');
			await expect.poll(() => otherPage.isClosed()).toBe(true);
			expect(await readFile(join(booksDir, '另一本书', chapter), 'utf8')).toBe(originalChapter + '迁移完成才关窗的字。');
		} finally {
			await app.evaluate(() => (globalThis as { restoreFs2?: () => void }).restoreFs2?.());
		}
	} finally {
		if (app) {
			await app.close();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
});
