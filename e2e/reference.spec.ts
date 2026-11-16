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
			'assistant.agent': 'custom',
			'assistant.command': process.execPath,
			'assistant.args': ['--experimental-strip-types', resolve('src/test/fakeAgent.ts'), '--close'],
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
		await expect(page.locator('.editor-pane:visible .lore-form')).toBeVisible();
		await expect(page.locator('.editor-pane:visible .lore-title-row h2')).toHaveText('林小满');
		await expect(page.locator('.editor-pane:visible .lore-pill > span')).toHaveText(['小满', '林姑娘']);
		await expect(page.locator('.editor:visible .cm-content')).toContainText('林小满每天天不亮就出门');
		await expect(page.locator('.editor:visible .cm-content')).not.toContainText('aliases:');
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
		const report = page.locator('.report-view:visible');
		await expect(report.locator('h1')).toHaveText('上次发给模型的内容');
		await expect(report.locator('h2').filter({ hasText: '用到的条目' })).toBeVisible();
		await expect(page.locator('.editor:visible')).toHaveCount(0);
		expect(server.received.length).toBeGreaterThan(0);
		expect(JSON.stringify(server.received.at(-1)!.body)).toContain('商量渡海');
	});
});

test('usage and last-request reports render Markdown, support copy, follow themes, and leave book files as plain Markdown', async () => {
	await withReferenceBook(async ({ page, app, menu }) => {
		await page.locator('.editor:visible .cm-content').click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('Alt+Backslash');
		await expect(page.locator('.ghost-text')).toContainText('门后传来一声叹息。');
		await expect(page.locator('.statusbar button').filter({ hasText: '今天 1 次' })).toBeVisible();

		// Status bar opens Usage and estimated cost rendered as Markdown.
		await page.locator('.statusbar button').filter({ hasText: '今天 1 次' }).click();
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('用量和估算花费');
		const usageView = page.locator('.report-view:visible');
		await expect(usageView.locator('h1')).toHaveText('用量和估算花费');
		await expect(usageView.locator('h2').first()).toContainText('今天（');
		await expect(usageView.locator('table').first().locator('thead th', { hasText: '请求数' })).toHaveCSS('text-align', 'right');
		await expect(usageView.locator('table').first().locator('tbody td').nth(1)).toHaveText('1');
		await expect(usageView.locator('ul li').first()).toBeVisible();
		await expect(page.locator('.editor:visible')).toHaveCount(0);

		// Last-request report renders headings, headless key-value table, entry table, nested list, and fenced code blocks.
		await menu('report');
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('上次发给模型的内容');
		const reportView = page.locator('.report-view:visible');
		await expect(reportView.locator('h1')).toHaveText('上次发给模型的内容');
		await expect(reportView.locator('table').first().locator('thead')).toHaveCount(0);
		await expect(reportView.locator('table').first().locator('tbody td').first()).toHaveText('时间');
		await expect(reportView.locator('h2').filter({ hasText: '大纲和前文' })).toBeVisible();
		await expect(reportView.locator('ul ul li').first()).toContainText('节点');
		await expect(reportView.locator('h3').filter({ hasText: '请求参数' })).toBeVisible();
		await expect(reportView.locator('pre code').first()).not.toBeEmpty();

		// Rendered report text can be selected and copied.
		await reportView.locator('h1').evaluate((heading) => {
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			const range = document.createRange();
			range.selectNodeContents(heading);
			selection.addRange(range);
			document.execCommand('copy');
		});
		expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('上次发给模型的内容');

		// Light and dark themes apply to the report view.
		await page.emulateMedia({ colorScheme: 'light' });
		const lightBg = await reportView.evaluate((el) => getComputedStyle(el).backgroundColor);
		await page.emulateMedia({ colorScheme: 'dark' });
		const darkBg = await reportView.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(lightBg).not.toBe(darkBg);
		await page.emulateMedia({ colorScheme: null });

		// Book Markdown files still show plain Markdown source in CodeMirror.
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '大纲', exact: true }).click();
		await page.locator('.sidebar.left .tree').getByRole('button', { name: '全书', exact: true }).click();
		await expect(page.locator('.editor:visible .cm-content')).toContainText('- 主线：');
		await expect(page.locator('.report-view:visible')).toHaveCount(0);
	});
});

test('lore entry frontmatter form uses single full-document representation, preserves undo across mode switches, guards frontmatter, and handles conflicts and CRLF cleanly', async () => {
	await withReferenceBook(async ({ page, book, menu }) => {
		// Chapters and outlines do not show the lore form.
		await expect(page.locator('.lore-form')).toHaveCount(0);
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '大纲', exact: true }).click();
		await page.locator('.sidebar.left .tree').getByRole('button', { name: '全书', exact: true }).click();
		await expect(page.locator('.lore-form')).toHaveCount(0);

		const towerRel = '设定/北角灯塔.md';
		const towerPath = join(book, towerRel);
		const initialTower = [
			'---',
			'# 礁石灯塔',
			'type: 地点',
			'aliases: [灯塔, 旧灯塔]  # 镇上叫法',
			'era: 旧港',
			'lit: false',
			'tags: [礁石, 航标]',
			'---',
			'雾港北角礁石上的白色灯塔，林小满常来。',
			'',
		].join('\n');
		await writeFile(towerPath, initialTower);

		const crlfRel = '设定/守塔人记录.md';
		const crlfPath = join(book, crlfRel);
		const initialCrlf = '---\r\n# 守塔备注\r\ntype: 人物\r\naliases: [老周, 守塔人]\r\n---\r\n北角灯塔最后一任守塔人。\r\n';
		await writeFile(crlfPath, initialCrlf);

		const crlfBytesBefore = await readFile(crlfPath);
		const crlfStatBefore = await stat(crlfPath);
		const towerBytesBefore = await readFile(towerPath);
		const towerStatBefore = await stat(towerPath);

		await page.locator('.sidebar.right .segments').getByRole('button', { name: '助手', exact: true }).click();
		await page.locator('.sidebar.left .segments').getByRole('button', { name: '设定', exact: true }).click();
		await expect(page.locator('.sidebar.left .lore-row').filter({ hasText: '守塔人记录' })).toBeVisible();
		await expect(page.locator('.sidebar.left .lore-row').filter({ hasText: '北角灯塔' })).toBeVisible();

		// Opening a CRLF lore entry without editing or moving the cursor immediately reports the body's real first line number (5 frontmatter lines -> line 6) and causes zero disk modifications.
		await page.locator('.sidebar.left .lore-row').filter({ hasText: '守塔人记录' }).click();
		const pane = page.locator('.editor-pane:visible');
		await expect(pane.locator('.lore-form')).toBeVisible();
		await expect(pane.locator('.lore-title-row h2')).toHaveText('守塔人记录');
		await expect(page.locator('.assistant-context')).toContainText('守塔人记录');
		await expect(page.locator('.assistant-context')).toContainText('第 6 行');
		await expect(pane.locator('.lore-form').getByLabel('类型')).toContainText('人物');
		await expect(pane.locator('.lore-form .lore-pill > span')).toHaveText(['老周', '守塔人']);
		await expect(pane.locator('.editor .cm-content')).toHaveText('北角灯塔最后一任守塔人。\n');
		await pane.locator('.lore-form').getByLabel('摘要').focus();
		await pane.locator('.lore-form').getByLabel('别名').focus();

		// Switch to LF lore entry without moving the cursor: assistant context immediately shows real body line 9, and disk bytes remain untouched.
		await page.locator('.sidebar.left .lore-row').filter({ hasText: '北角灯塔' }).click();
		const form = pane.locator('.lore-form');
		await expect(form).toBeVisible();
		await expect(form.locator('.lore-title-row h2')).toHaveText('北角灯塔');
		await expect(page.locator('.assistant-context')).toContainText('北角灯塔');
		await expect(page.locator('.assistant-context')).toContainText('第 9 行');
		await expect(pane.locator('.editor .cm-content')).toHaveText('雾港北角礁石上的白色灯塔，林小满常来。\n');
		await expect(pane.locator('.editor .cm-content')).not.toContainText('---');
		await expect(pane.locator('.editor .lore-name').filter({ hasText: '林小满' })).toBeVisible();

		// Title and property grid left-align with the prose body (not centered in wide window) and title font is larger than body font.
		const layoutMetrics = await pane.evaluate((root) => {
			const h2 = root.querySelector('.lore-title-row h2')!;
			const props = root.querySelector('.lore-props')!;
			const line = root.querySelector('.cm-line')!;
			const scroller = root.querySelector('.cm-scroller')!;
			return {
				titleLeft: h2.getBoundingClientRect().left,
				propsLeft: props.getBoundingClientRect().left,
				propsWidth: props.getBoundingClientRect().width,
				lineLeft: line.getBoundingClientRect().left,
				lineWidth: line.getBoundingClientRect().width,
				titleSize: parseFloat(getComputedStyle(h2).fontSize),
				bodySize: parseFloat(getComputedStyle(scroller).fontSize),
			};
		});
		expect(Math.abs(layoutMetrics.titleLeft - layoutMetrics.lineLeft)).toBeLessThanOrEqual(1);
		expect(Math.abs(layoutMetrics.propsLeft - layoutMetrics.lineLeft)).toBeLessThanOrEqual(1);
		expect(Math.abs(layoutMetrics.propsWidth - layoutMetrics.lineWidth)).toBeLessThanOrEqual(2);
		expect(layoutMetrics.titleSize).toBeGreaterThan(layoutMetrics.bodySize);

		const typeButton = form.getByLabel('类型');
		const aliasesInput = form.getByLabel('别名');
		const alwaysSwitch = form.getByRole('switch', { name: '常驻', exact: true });
		const summaryInput = form.getByLabel('摘要');
		const eraInput = form.getByLabel('era');
		const litSwitch = form.getByRole('switch', { name: 'lit', exact: true });
		const tagsInput = form.getByLabel('tags');
		const aliasRow = aliasesInput.locator('..');
		const tagsRow = tagsInput.locator('..');

		await expect(typeButton).toContainText('地点');
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '旧灯塔']);
		await expect(aliasesInput).toHaveAttribute('placeholder', '＋ 添加');
		await expect(alwaysSwitch).not.toBeChecked();
		await expect(summaryInput).toHaveValue('');
		await expect(summaryInput).toHaveAttribute('placeholder', '添加摘要');
		await expect(eraInput).toHaveValue('旧港');
		await expect(litSwitch).not.toBeChecked();
		await expect(tagsRow.locator('.lore-pill > span')).toHaveText(['礁石', '航标']);

		await summaryInput.focus();
		expect(await summaryInput.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
		await aliasesInput.focus();
		await page.waitForTimeout(1200);
		expect(Buffer.compare(await readFile(crlfPath), crlfBytesBefore)).toBe(0);
		expect((await stat(crlfPath)).mtimeMs).toBe(crlfStatBefore.mtimeMs);
		expect(Buffer.compare(await readFile(towerPath), towerBytesBefore)).toBe(0);
		expect((await stat(towerPath)).mtimeMs).toBe(towerStatBefore.mtimeMs);

		// Sending an assistant message without moving the editor cursor carries line 9 (not line 1).
		await page.getByRole('textbox', { name: '给助手的消息' }).fill('echo');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.locator('.assistant-reply').first()).toContainText('光标在第 9 行');

		// 源码 and 表单 toggle sit at the exact same position beside the entry title.
		const sourceBtnBox = (await form.getByRole('button', { name: '源码', exact: true }).boundingBox())!;
		await form.getByRole('button', { name: '源码', exact: true }).click();
		await expect(pane.locator('.lore-form')).toHaveCount(0);
		const formBtn = pane.getByRole('button', { name: '表单', exact: true });
		await expect(formBtn).toBeVisible();
		const formBtnBox = (await formBtn.boundingBox())!;
		expect(Math.abs(sourceBtnBox.x - formBtnBox.x)).toBeLessThanOrEqual(2);
		expect(Math.abs(sourceBtnBox.y - formBtnBox.y)).toBeLessThanOrEqual(2);
		await formBtn.click();
		await expect(form).toBeVisible();

		// In-file find (⌘F) matching frontmatter-only text automatically switches the editor to 源码 mode and selects the match.
		await menu('find');
		const findPanel = pane.locator('.cm-search');
		await expect(findPanel).toBeVisible();
		await findPanel.locator('input[name="search"]').fill('礁石灯塔');
		await findPanel.getByRole('button', { name: '下一个', exact: true }).click();
		await expect(pane.locator('.lore-form')).toHaveCount(0);
		await expect(pane.getByRole('button', { name: '表单', exact: true })).toBeVisible();
		await expect(page.locator('.assistant-context')).toContainText('选中 4 字 礁石灯塔');
		await findPanel.getByRole('button', { name: '关闭', exact: true }).click();
		await pane.getByRole('button', { name: '表单', exact: true }).click();
		await expect(form).toBeVisible();

		// Whole-book search (⌘⇧F) jumping to a frontmatter match switches to 源码 mode for both an open form-mode tab and a newly opened lore entry.
		await menu('searchBook');
		const searchInput = page.getByRole('textbox', { name: '全书搜索', exact: true });
		await searchInput.fill('镇上叫法');
		await expect(page.getByRole('option')).toHaveCount(1);
		await page.keyboard.press('Enter');
		await expect(pane.locator('.lore-form')).toHaveCount(0);
		await expect(pane.getByRole('button', { name: '表单', exact: true })).toBeVisible();
		await expect(page.locator('.assistant-context')).toContainText('第 4 行');
		await pane.getByRole('button', { name: '表单', exact: true }).click();
		await expect(form).toBeVisible();

		await menu('searchBook');
		await searchInput.fill('type: 人物');
		const linOption = page.getByRole('group', { name: '人物/林小满.md', exact: true }).getByRole('option');
		await expect(linOption).toHaveCount(1);
		await linOption.click();
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('林小满');
		await expect(pane.locator('.lore-form')).toHaveCount(0);
		await expect(pane.getByRole('button', { name: '表单', exact: true })).toBeVisible();
		await expect(page.locator('.assistant-context')).toContainText('林小满');
		await expect(page.locator('.assistant-context')).toContainText('第 2 行');

		// Switch back to 北角灯塔 in form mode for subsequent form editing assertions.
		await page.getByRole('tab').filter({ hasText: '北角灯塔' }).click();
		await expect(form).toBeVisible();

		// Type menu: lists ALL existing types in the book unfiltered, checks current type, closes on Escape / outside click returning focus to 类型, and edits ONLY the `type` line.
		await typeButton.click();
		const typeMenu = form.locator('.lore-type-menu');
		await expect(typeMenu).toBeVisible();
		const listedTypes = await typeMenu.getByRole('option').allTextContents();
		expect(listedTypes.map((text) => text.replace('✓', '').trim())).toEqual(expect.arrayContaining(['人物', '地点', '物件', '文风']));
		await expect(typeMenu.getByRole('option', { selected: true })).toContainText('地点');
		await expect(typeMenu.getByRole('option', { selected: true })).toContainText('✓');
		const newTypeInput = typeMenu.getByPlaceholder('新类型…');
		await newTypeInput.fill('未提交草稿');
		// Typing in 新类型… does not filter out existing options.
		expect((await typeMenu.getByRole('option').allTextContents()).length).toBeGreaterThanOrEqual(4);
		await page.keyboard.press('Escape');
		await expect(typeMenu).toHaveCount(0);
		await expect(typeButton).toBeFocused();
		expect(await readFile(towerPath, 'utf8')).toBe(initialTower);

		// Outside click closes menu and returns focus to 类型.
		await typeButton.click();
		await expect(typeMenu).toBeVisible();
		await form.locator('.lore-title-row h2').click();
		await expect(typeMenu).toHaveCount(0);
		await expect(typeButton).toBeFocused();

		// Starting IME composition in 新类型… and clicking an existing type closes the menu, ends composition, and lets saving finish cleanly.
		await typeButton.click();
		const composingTypeInput = typeMenu.getByPlaceholder('新类型…');
		await composingTypeInput.focus();
		await composingTypeInput.evaluate((el: HTMLInputElement) => {
			el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'shi' }));
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
			setter.call(el, 'shi');
			el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'shi' }));
		});
		await typeMenu.getByRole('option', { name: /物件/ }).click();
		await expect(typeMenu).toHaveCount(0);
		await expect(typeButton).toContainText('物件');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(initialTower.replace('type: 地点', 'type: 物件'));
		expect(await page.evaluate(() => window.novel.book.read('设定/北角灯塔.md').then((f) => f.text.includes('type: 物件')))).toBe(true);

		await typeButton.click();
		await typeMenu.getByPlaceholder('新类型…').fill('建筑');
		await typeMenu.getByPlaceholder('新类型…').press('Enter');
		await expect(typeMenu).toHaveCount(0);
		await expect(typeButton).toContainText('建筑');
		await expect(typeButton).toBeFocused();
		const afterTypeOnly = initialTower.replace('type: 地点', 'type: 建筑');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterTypeOnly);
		await expect(page.locator('.sidebar.left summary').filter({ hasText: '建筑' })).toBeVisible();

		// Aliases: add one, ignore duplicate, delete one, undo single deletion, paste comma/顿号-separated text — only `aliases` line changes byte-for-byte.
		await aliasesInput.fill('北塔');
		await aliasesInput.press('Enter');
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '旧灯塔', '北塔']);
		const afterAliasAdd = afterTypeOnly.replace('aliases: [灯塔, 旧灯塔]  # 镇上叫法', 'aliases: [灯塔, 旧灯塔, 北塔]  # 镇上叫法');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterAliasAdd);

		// Duplicate alias is ignored without modifying the file.
		await aliasesInput.fill('灯塔');
		await aliasesInput.press('Enter');
		await expect(aliasesInput).toHaveValue('');
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '旧灯塔', '北塔']);
		expect(await readFile(towerPath, 'utf8')).toBe(afterAliasAdd);

		// Delete one alias (`旧灯塔`) via ✕, verify exact bytes, then Undo (`⌘Z`) restores ONLY that one deleted alias (`北塔` addition stays intact).
		await aliasRow.getByRole('button', { name: '删除 旧灯塔', exact: true }).click();
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '北塔']);
		const afterAliasRemove = afterTypeOnly.replace('aliases: [灯塔, 旧灯塔]  # 镇上叫法', 'aliases: [灯塔, 北塔]  # 镇上叫法');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterAliasRemove);

		await page.keyboard.press('Meta+z');
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '旧灯塔', '北塔']);
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterAliasAdd);

		// Delete `旧灯塔` again, then paste comma/顿号 text containing both new aliases and an existing duplicate.
		await aliasRow.getByRole('button', { name: '删除 旧灯塔', exact: true }).click();
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '北塔']);
		await aliasesInput.evaluate((el: HTMLInputElement) => {
			el.focus();
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', '白塔，灯塔、礁塔, 海标');
			el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		});
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['灯塔', '北塔', '白塔', '礁塔', '海标']);
		const afterAliasPaste = afterTypeOnly.replace(
			'aliases: [灯塔, 旧灯塔]  # 镇上叫法',
			'aliases: [灯塔, 北塔, 白塔, 礁塔, 海标]  # 镇上叫法',
		);
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterAliasPaste);

		// IME composition does not write to document mid-composition, and writes immediately when composition ends.
		await eraInput.focus();
		await eraInput.evaluate((el: HTMLInputElement) => {
			el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'xin' }));
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
			setter.call(el, '新纪元');
			el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '新纪元' }));
		});
		await page.waitForTimeout(1200);
		expect(await readFile(towerPath, 'utf8')).toBe(afterAliasPaste);
		await eraInput.evaluate((el: HTMLInputElement) => {
			el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '新纪元' }));
		});
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterAliasPaste.replace('era: 旧港', 'era: 新纪元'));

		// Immediate live writes without pressing Enter or blurring.
		await eraInput.fill('十年前');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(afterAliasPaste.replace('era: 旧港', 'era: 十年前'));

		// Toggle 常驻 switch on and off and back on.
		await alwaysSwitch.click();
		await expect(alwaysSwitch).toBeChecked();
		await alwaysSwitch.click();
		await expect(alwaysSwitch).not.toBeChecked();
		await alwaysSwitch.click();
		await expect(alwaysSwitch).toBeChecked();

		// Summary keeps single line on disk: Enter does nothing, pasted newlines become spaces.
		await summaryInput.focus();
		await summaryInput.fill('北角礁石上的旧灯塔。');
		await summaryInput.press('Enter');
		await expect(summaryInput).toHaveValue('北角礁石上的旧灯塔。');
		await summaryInput.evaluate((el: HTMLTextAreaElement) => {
			el.focus();
			el.setSelectionRange(0, el.value.length);
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', '北角礁石上的\n旧灯塔，\r\n守望航道。');
			el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		});
		await expect(summaryInput).toHaveValue('北角礁石上的 旧灯塔， 守望航道。');

		// Extra boolean switch and extra string-list pills.
		await litSwitch.click();
		await expect(litSwitch).toBeChecked();
		await tagsRow.getByRole('button', { name: '删除 礁石', exact: true }).click();
		await tagsInput.fill('风暴，铜钟');
		await tagsInput.press('Enter');
		await expect(tagsRow.locator('.lore-pill > span')).toHaveText(['航标', '风暴', '铜钟']);

		const expectedEdited = [
			'---',
			'# 礁石灯塔',
			'type: 建筑',
			'aliases: [灯塔, 北塔, 白塔, 礁塔, 海标]  # 镇上叫法',
			'era: 十年前',
			'lit: true',
			'tags: [航标, 风暴, 铜钟]',
			'always: true',
			'summary: 北角礁石上的 旧灯塔， 守望航道。',
			'---',
			'雾港北角礁石上的白色灯塔，林小满常来。',
			'',
		].join('\n');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedEdited);

		// Form edit -> switch to 源码 -> Undo -> Redo: byte-for-byte match at each step, always a single frontmatter block.
		await eraInput.blur();
		await eraInput.focus();
		await eraInput.fill('百年前');
		const expectedCentury = expectedEdited.replace('era: 十年前', 'era: 百年前');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedCentury);

		const cmDoc = async () => (await pane.locator('.editor .cm-line').allTextContents()).join('\n');
		await form.getByRole('button', { name: '源码', exact: true }).click();
		await expect(pane.locator('.lore-form')).toHaveCount(0);
		await expect.poll(cmDoc).toBe(expectedCentury);

		await page.keyboard.press('Meta+z');
		await expect.poll(cmDoc).toBe(expectedEdited);
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedEdited);
		expect((await readFile(towerPath, 'utf8')).match(/^---$/gm)?.length).toBe(2);

		await page.keyboard.press('Meta+Shift+z');
		await expect.poll(cmDoc).toBe(expectedCentury);
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedCentury);
		expect((await readFile(towerPath, 'utf8')).match(/^---$/gm)?.length).toBe(2);

		// Edit in 源码 -> switch back to 表单 -> Undo reverts cleanly.
		await pane.locator('.editor .cm-content').click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('源码追加行。');
		const expectedWithSourceAppend = expectedCentury + '源码追加行。';
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedWithSourceAppend);

		await pane.getByRole('button', { name: '表单', exact: true }).click();
		await expect(form).toBeVisible();
		await expect(pane.locator('.editor .cm-content')).toContainText('源码追加行。');
		await pane.locator('.editor .cm-content').click();
		await page.keyboard.press('Meta+z');
		await expect(pane.locator('.editor .cm-content')).not.toContainText('源码追加行。');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedCentury);

		// In form mode, Select All + Delete in the body leaves frontmatter completely intact; Backspace at body start is a no-op.
		const expectedFrontmatterOnly = expectedCentury.slice(0, expectedCentury.indexOf('\n---\n') + '\n---\n'.length);
		await pane.locator('.editor .cm-content').click();
		await page.keyboard.press('Meta+ArrowUp');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Meta+a');
		await page.keyboard.press('Backspace');
		await expect(form).toBeVisible();
		await expect(pane.locator('.editor .cm-content')).toHaveText('');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedFrontmatterOnly);

		await page.keyboard.press('Meta+z');
		await expect(pane.locator('.editor .cm-content')).toHaveText('雾港北角礁石上的白色灯塔，林小满常来。\n');
		await expect.poll(() => readFile(towerPath, 'utf8')).toBe(expectedCentury);

		// Frontmatter without a newline after closing ---, or non-lossless YAML, displays raw source without touching the file.
		const unsafeCases: Array<[string, string]> = [
			['设定/无尾换行.md', '---\ntype: 物件\n---'],
			['设定/多行条目.md', '---\ntype: 物件\nsummary: |\n  第一行\n  第二行\n---\n多行正文。\n'],
			['设定/嵌套条目.md', '---\ntype: 物件\nmeta:\n  level: 2\n---\n嵌套正文。\n'],
			['设定/坏语法.md', '---\naliases: [未闭合\n---\n坏语法正文。\n'],
		];
		for (const [rel, raw] of unsafeCases) {
			await writeFile(join(book, rel), raw);
		}
		for (const [rel, raw] of unsafeCases) {
			const entryName = rel.slice(rel.indexOf('/') + 1, -3);
			await expect(page.locator('.sidebar.left .lore-row').filter({ hasText: entryName })).toBeVisible();
			await page.locator('.sidebar.left .lore-row').filter({ hasText: entryName }).click();
			await expect(page.locator('.editor-pane:visible .lore-form')).toHaveCount(0);
			await expect(page.locator('.editor-pane:visible .lore-mode-toggle')).toHaveCount(0);
			await expect(page.locator('.editor:visible .cm-content')).toContainText('---');
			expect(await readFile(join(book, rel), 'utf8')).toBe(raw);
		}

		// Typing summary mid-way when the file is modified externally enters conflict handling instead of silently overwriting on tab switch.
		await page.getByRole('tab').filter({ hasText: '北角灯塔' }).click();
		await expect(form).toBeVisible();
		const externalMidEdit = expectedCentury.replace('北角礁石上的 旧灯塔， 守望航道。', '外部抢先保存的摘要。');
		await summaryInput.focus();
		await summaryInput.fill('正在输入到一半的摘要');
		await writeFile(towerPath, externalMidEdit);
		const conflict = pane.locator('.notice').filter({ hasText: '磁盘上的文件已更改' });
		await expect(conflict).toBeVisible();

		// Switching tabs away and back must NOT overwrite the external file on disk.
		await page.getByRole('tab').filter({ hasText: '全书' }).click();
		await page.waitForTimeout(300);
		expect(await readFile(towerPath, 'utf8')).toBe(externalMidEdit);
		await page.getByRole('tab').filter({ hasText: '北角灯塔' }).click();
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: '用磁盘的', exact: true }).click();
		await expect(conflict).toHaveCount(0);
		await expect(summaryInput).toHaveValue('外部抢先保存的摘要。');

		// Clean external reload, context-menu edits, and assistant rewrite also update the form immediately.
		const diskUpdated = externalMidEdit.replace('外部抢先保存的摘要。', '外部修改后的摘要。');
		await writeFile(towerPath, diskUpdated);
		await expect(summaryInput).toHaveValue('外部修改后的摘要。');

		const row = page.locator('.sidebar.left .lore-row').filter({ hasText: '北角灯塔' });
		await row.click({ button: 'right' });
		await page.getByRole('menuitem', { name: '改别名', exact: true }).click();
		await page.getByRole('dialog', { name: '改别名', exact: true }).getByLabel('别名').fill('老塔、白塔');
		await page.getByRole('button', { name: '确定', exact: true }).click();
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['老塔', '白塔']);

		await row.click({ button: 'right' });
		await page.getByRole('menuitem', { name: '改类型', exact: true }).click();
		await page.getByRole('dialog', { name: '改类型', exact: true }).locator('input').fill('古迹');
		await page.getByRole('button', { name: '确定', exact: true }).click();
		await expect(typeButton).toContainText('古迹');

		const assistantRewritten = [
			'---',
			'type: 遗迹',
			'aliases: [北角古塔]',
			'always: false',
			'summary: 助手更新后的摘要。',
			'---',
			'助手更新后的灯塔正文。',
			'',
		].join('\n');
		await page
			.getByRole('textbox', { name: '给助手的消息' })
			.fill(JSON.stringify(['write', towerRel, assistantRewritten]) + '\nsay 已改好灯塔条目');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.locator('.assistant-reply').last()).toContainText('已改好灯塔条目');
		await expect(typeButton).toContainText('遗迹');
		await expect(aliasRow.locator('.lore-pill > span')).toHaveText(['北角古塔']);
		await expect(alwaysSwitch).not.toBeChecked();
		await expect(summaryInput).toHaveValue('助手更新后的摘要。');
		await expect(pane.locator('.editor .cm-content')).toHaveText('助手更新后的灯塔正文。\n');
	});
});

test('left lore tree group + and bottom row preselect types, and new entry dialog creates entries with existing or custom types', async () => {
	await withReferenceBook(async ({ page, book }) => {
		const leftLore = page.locator('.sidebar.left');
		await leftLore.locator('.segments').getByRole('button', { name: '设定', exact: true }).click();

		// No top 新建条目 button; bottom row is ＋ 新建条目.
		await expect(leftLore.locator('.panel-actions')).toHaveCount(0);
		const bottomNew = leftLore.getByRole('button', { name: '＋ 新建条目', exact: true });
		await expect(bottomNew).toBeVisible();

		// Currently open tab is chapter 第2章 灯塔 -> bottom ＋ 新建条目 preselects the first type (人物).
		await bottomNew.click();
		const dialog = page.getByRole('dialog', { name: '新建条目', exact: true });
		await expect(dialog).toBeVisible();
		const nameInput = dialog.getByLabel('名字');
		await expect(nameInput).toBeFocused();
		await expect(dialog.getByRole('button', { name: '人物', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 人物/');
		await expect(dialog.getByRole('button', { name: '新建', exact: true })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);

		// When a lore entry (潮汐钟, type 物件) is active, bottom ＋ 新建条目 preselects 物件.
		await leftLore.locator('.lore-row').filter({ hasText: '潮汐钟' }).click();
		await expect(page.locator('.editor-pane:visible .lore-title-row h2')).toHaveText('潮汐钟');
		await bottomNew.click();
		await expect(dialog.getByRole('button', { name: '物件', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 设定/');
		await dialog.getByRole('button', { name: '取消', exact: true }).click();
		await expect(dialog).toHaveCount(0);

		// Hovering a group summary reveals ＋ on the right; clicking it opens the dialog with that group's type preselected.
		const placeSummary = leftLore.locator('summary.lore-group-summary').filter({ hasText: '地点' });
		const placePlus = placeSummary.getByRole('button', { name: '＋', exact: true });
		await expect(placePlus).toBeHidden();
		await placeSummary.hover();
		await expect(placePlus).toBeVisible();
		await placePlus.click();
		await expect(dialog).toBeVisible();
		await expect(nameInput).toBeFocused();
		await expect(dialog.getByRole('button', { name: '地点', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 设定/');

		// Empty, duplicate, or invalid names disable 新建 without showing any error alert.
		const createBtn = dialog.getByRole('button', { name: '新建', exact: true });
		await expect(createBtn).toBeDisabled();
		await nameInput.fill('雾港');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 设定/雾港.md');
		await expect(createBtn).toBeDisabled();
		await nameInput.press('Enter');
		await expect(dialog).toBeVisible();
		await expect(page.getByRole('alert')).toHaveCount(0);

		await nameInput.fill('北角/新地');
		await expect(createBtn).toBeDisabled();
		await nameInput.fill('..');
		await expect(createBtn).toBeDisabled();

		// Switching type chip to 人物 updates target folder to 人物/.
		await nameInput.fill('沈三娘');
		await dialog.getByRole('button', { name: '人物', exact: true }).click();
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 人物/沈三娘.md');
		await expect(createBtn).toBeEnabled();

		// Tabbing from 名字 to unselected type chips: Enter and Space select the focused chip without submitting 新建.
		await nameInput.focus();
		await page.keyboard.press('Tab');
		await expect(dialog.getByRole('button', { name: '人物', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		const placeChip = dialog.getByRole('button', { name: '地点', exact: true });
		await expect(placeChip).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(dialog).toBeVisible();
		await expect(placeChip).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.getByRole('button', { name: '人物', exact: true })).toHaveAttribute('aria-pressed', 'false');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 设定/沈三娘.md');

		await page.keyboard.press('Tab');
		const styleChip = dialog.getByRole('button', { name: '文风', exact: true });
		await expect(styleChip).toBeFocused();
		await page.keyboard.press('Space');
		await expect(dialog).toBeVisible();
		await expect(styleChip).toHaveAttribute('aria-pressed', 'true');
		await expect(placeChip).toHaveAttribute('aria-pressed', 'false');

		await dialog.getByRole('button', { name: '人物', exact: true }).click();
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 人物/沈三娘.md');

		// ＋ 新类型: click turns into input, Escape reverts to ＋ 新类型, Enter adds chip and selects it.
		await dialog.getByRole('button', { name: '＋ 新类型', exact: true }).click();
		const chipInput = dialog.locator('.lore-chip-input');
		await expect(chipInput).toBeFocused();
		await chipInput.fill('放弃类型');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 设定/沈三娘.md');
		await chipInput.press('Escape');
		await expect(chipInput).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('button', { name: '＋ 新类型', exact: true })).toBeVisible();
		await expect(dialog.getByRole('button', { name: '人物', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 人物/沈三娘.md');

		await dialog.getByRole('button', { name: '＋ 新类型', exact: true }).click();
		await expect(chipInput).toBeFocused();
		await chipInput.fill('势力');
		await chipInput.press('Enter');
		await expect(chipInput).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: '势力', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.lore-dialog-where')).toHaveText('建在 设定/沈三娘.md');
		await expect(createBtn).toBeEnabled();

		// Enter creates the entry, opens it in the editor, writes expected file on disk, and shows the new group in the left sidebar.
		await page.keyboard.press('Enter');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('.tabs [aria-selected=true]')).toContainText('沈三娘');
		await expect(page.locator('.editor-pane:visible .lore-title-row h2')).toHaveText('沈三娘');
		await expect(page.locator('.editor-pane:visible .lore-form').getByLabel('类型')).toContainText('势力');
		await expect(leftLore.locator('summary.lore-group-summary').filter({ hasText: '势力' })).toBeVisible();
		await expect(leftLore.locator('details').filter({ hasText: '势力' }).locator('.lore-row').filter({ hasText: '沈三娘' })).toBeVisible();

		const createdContent = await readFile(join(book, '设定/沈三娘.md'), 'utf8');
		expect(createdContent).toBe('---\ntype: 势力\naliases: []\nsummary:\n---\n\n## 想要什么\n\n## 成员\n\n## 和其他势力的关系\n');
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

test('scrolling closes hover cards and keeps the editor scrollable while keyboard cards remain', async () => {
	await withReferenceBook(async ({ page, book }) => {
		const file = join(book, chapter);
		await writeFile(file, (await readFile(file, 'utf8')) + '\n\n' + '林小满沿着海边走，钟声从远处传来。\n\n'.repeat(120));
		const scroller = page.locator('.editor:visible .cm-scroller');
		await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(600);
		const name = page.locator('.editor:visible .lore-name').filter({ hasText: '林小满' }).first();
		await name.hover();
		await expect(page.locator('.lore-tooltip')).toBeVisible();
		await page.mouse.wheel(0, 120);
		await expect(page.locator('.lore-tooltip')).toHaveCount(0);
		const before = await scroller.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, 120);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
		await scroller.evaluate((element) => {
			element.scrollTop = 0;
		});
		await name.click();
		await page.keyboard.press('Meta+i');
		await expect(page.locator('.lore-tooltip')).toBeVisible();
		await scroller.evaluate((element) => {
			element.scrollTop += 20;
		});
		await expect(page.locator('.lore-tooltip')).toBeVisible();
	});
});
