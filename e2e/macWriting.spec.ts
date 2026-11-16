import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { countWords } from '../src/core/text';
import { ICLOUD_BOOKS_FOLDER } from '../src/main/book/icloud';
import { zh } from '../src/renderer/strings';
import { settingGroups } from '../src/shared/settings';
import { fakeServer, stream, openaiText, openaiUsage, OPENAI_END } from '../src/test/fakeServer';

const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';

async function withApp(
	initialSettings: Record<string, unknown>,
	run: (fixture: {
		app: ElectronApplication;
		page: Page;
		book: string;
		data: string;
		server: Awaited<ReturnType<typeof fakeServer>>;
	}) => Promise<void>,
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-mac-writing-e2e-')));
	const book = join(root, 'book');
	const data = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	let replyIndex = 0;
	const server = await fakeServer((res, req) => {
		const maxTokens = Number(req.body.max_tokens ?? req.body.max_completion_tokens ?? 999);
		if (maxTokens <= 50) {
			stream(res, [openaiText('2'), openaiUsage({ prompt_tokens: 1000, completion_tokens: 20 }), OPENAI_END]);
		} else {
			stream(res, [
				openaiText(`海风吹过第${++replyIndex}道石阶。`),
				openaiUsage({ prompt_tokens: 2000, completion_tokens: 50 }),
				OPENAI_END,
			]);
		}
	});
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			trigger: 'manual',
			provider: 'openaiCompatible',
			'openaiCompatible.model': 'test-model',
			'openaiCompatible.baseUrl': server.baseUrl,
			...initialSettings,
		}),
	);
	await writeFile(
		join(data, 'windows.json'),
		JSON.stringify({
			open: [book],
			recent: [book],
			books: { [book]: { tabs: [{ path: chapter, anchor: 0, head: 0 }], active: chapter } },
		}),
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	const app = await electron.launch({ env, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
	const child = app.process();
	const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
	try {
		const page = await app.firstWindow();
		await page.waitForLoadState('domcontentloaded');
		await expect(page.locator('.editor:visible .cm-content')).toContainText('林小满');
		await run({ app, page, book, data, server });
	} finally {
		if (child.exitCode === null) {
			await app.close();
		}
		await exited;
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
}

test('dark mode accent cursor, heading # hide/reveal, byte-identical visual formatting, whole-indent Backspace, and word counts', async () => {
	await withApp({ enabled: false }, async ({ page, book }) => {
		const chapterPath = join(book, chapter);
		const originalBytes = await readFile(chapterPath);
		const originalText = originalBytes.toString('utf8');
		const totalWords = countWords(originalText);

		const content = page.locator('.editor:visible .cm-content');
		await content.click();

		// 1. Dark mode cursor is --accent (rgb(224, 138, 95)), not black, with breathing blink and 80ms smooth transition.
		await page.emulateMedia({ colorScheme: 'dark' });
		const cursor = page.locator('.editor:visible .cm-cursor').first();
		await expect(cursor).toBeVisible();
		const cursorStyles = await page.locator('.editor:visible .cm-editor').evaluate((editor) => {
			const cur = editor.querySelector('.cm-cursor')!;
			const layer = editor.querySelector('.cm-cursorLayer')!;
			const curStyle = getComputedStyle(cur);
			const layerStyle = getComputedStyle(layer);
			const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
			return {
				borderLeftColor: curStyle.borderLeftColor,
				transitionDuration: curStyle.transitionDuration,
				animationTimingFunction: layerStyle.animationTimingFunction,
				accent,
			};
		});
		expect(cursorStyles.accent).toBe('#e08a5f');
		expect(cursorStyles.borderLeftColor).toBe('rgb(224, 138, 95)');
		expect(cursorStyles.borderLeftColor).not.toBe('rgb(0, 0, 0)');
		expect(cursorStyles.transitionDuration).toContain('0.08s');
		expect(cursorStyles.animationTimingFunction).toBe('ease-in-out');
		await page.emulateMedia({ colorScheme: null });

		// 2. Heading line reveals "# " when cursor is on line 1, hides "# " when cursor leaves line 1, and leaves disk bytes untouched.
		await page.keyboard.press('Meta+ArrowUp');
		const headingLine = page.locator('.editor:visible .cm-line.chapter-heading');
		await expect(headingLine).toHaveText('# 第2章 灯塔');

		await page.keyboard.press('Meta+ArrowDown');
		await expect(headingLine).toHaveText('第2章 灯塔');
		expect(Buffer.compare(await readFile(chapterPath), originalBytes)).toBe(0);

		// Moving cursor onto a blank line still works in blank-line-separated files, and blank lines render shorter than prose lines.
		const heights = await page.locator('.editor:visible').evaluate((editor) => {
			const blank = editor.querySelector('.cm-line.chapter-blank')!;
			const prose = editor.querySelector('.cm-line.can-indent')!;
			return {
				blankHeight: blank.getBoundingClientRect().height,
				proseHeight: prose.getBoundingClientRect().height,
			};
		});
		expect(heights.blankHeight).toBeGreaterThan(0);
		expect(heights.blankHeight).toBeLessThan(heights.proseHeight * 0.75);

		// Re-entering line 1 shows "# " again.
		await page.keyboard.press('Meta+ArrowUp');
		await expect(headingLine).toHaveText('# 第2章 灯塔');
		await page.keyboard.press('Meta+ArrowDown');
		await expect(headingLine).toHaveText('第2章 灯塔');

		// 3. Toggle first-line indent, adjust paragraph spacing, heading center, focus paragraph, and save -> file stays byte-for-byte identical.
		await page.evaluate(async () => {
			await window.novel.settings.set('editor.firstLineIndent', false);
			await window.novel.settings.set('editor.firstLineIndent', true);
			await window.novel.settings.set('editor.paragraphSpacing', 'full');
			await window.novel.settings.set('editor.headingCenter', true);
			await window.novel.settings.set('editor.focusParagraph', true);
		});
		await expect(page.locator('.editor:visible .cm-line.can-indent').first()).toHaveCSS('text-indent', '34px');
		await expect(headingLine).toHaveCSS('text-align', 'center');
		await expect(page.locator('.editor:visible .cm-line.dim-paragraph').first()).toHaveCSS('opacity', '0.38');
		await page.waitForTimeout(1200);
		expect(Buffer.compare(await readFile(chapterPath), originalBytes)).toBe(0);

		// Also check visually equal paragraph spacing between blank-line (\n\n) and single-newline (\n) chapters.
		const singleLineRel = '正文/第一卷 雾港/第一幕 来信/第3章 单行分段.md';
		await writeFile(join(book, singleLineRel), '# 第3章 单行分段\n第一段文字。\n第二段文字。\n');
		const blankLineRel = '正文/第一卷 雾港/第一幕 来信/第4章 空行分段.md';
		await writeFile(join(book, blankLineRel), '# 第4章 空行分段\n\n第一段文字。\n\n第二段文字。\n');
		const tree = page.getByRole('tree', { name: '章节', exact: true });
		await expect(tree.getByRole('button', { name: /第3章 单行分段/ })).toBeVisible();
		await expect(tree.getByRole('button', { name: /第4章 空行分段/ })).toBeVisible();
		await tree.getByRole('button', { name: /第3章 单行分段/ }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', singleLineRel);
		const singleGap = await page.locator('.editor:visible').evaluate((editor) => {
			const lines = [...editor.querySelectorAll('.cm-line.can-indent')];
			return lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top;
		});
		await tree.getByRole('button', { name: /第4章 空行分段/ }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', blankLineRel);
		const blankGap = await page.locator('.editor:visible').evaluate((editor) => {
			const lines = [...editor.querySelectorAll('.cm-line.can-indent')];
			return lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top;
		});
		expect(Math.abs(singleGap - blankGap)).toBeLessThanOrEqual(2);

		// Switch back to 第2章 灯塔; creating those two test chapters added words, so capture current daily baseline.
		await tree.getByRole('button', { name: /第2章 灯塔/ }).click();
		await expect(page.locator('.editor:visible .cm-content')).toHaveAttribute('aria-label', chapter);
		await page.evaluate(() => window.novel.settings.set('editor.dailyWordGoal', 3000));
		await expect(page.locator('.status-daily-words')).toContainText('目标 3,000 字');
		const baselineMatch = (await page.locator('.status-daily-words').textContent())!.match(/今天 (-?[\d,]+) \/ 目标 3,000 字/)!;
		const baselineWords = Number(baselineMatch[1].replace(/,/g, ''));

		// 4. Cursor position and selected words in bottom bar right, plus today's net word count on typing and deleting.
		const activeContent = page.locator('.editor:visible .cm-content');
		await activeContent.click();
		await page.keyboard.press('Meta+ArrowUp');
		await expect(page.locator('.status-chapter-words')).toHaveText(`0 / ${totalWords.toLocaleString()} 字`);

		await page.keyboard.press('Meta+ArrowDown');
		await expect(page.locator('.status-chapter-words')).toHaveText(`${totalWords.toLocaleString()} / ${totalWords.toLocaleString()} 字`);

		// Select 3 non-whitespace characters backwards (chapter ends with trailing \n) -> shows "选中 3 / <total> 字".
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('Shift+ArrowLeft');
		await page.keyboard.press('Shift+ArrowLeft');
		await expect(page.locator('.status-chapter-words')).toHaveText(`选中 3 / ${totalWords.toLocaleString()} 字`);

		// Collapse selection to end, type 5 words -> today's word count increases by 5; delete 2 -> decreases by 2.
		await page.keyboard.press('ArrowRight');
		await page.keyboard.insertText('新写五个字');
		await expect(page.locator('.status-daily-words')).toHaveText(`今天 ${(baselineWords + 5).toLocaleString()} / 目标 3,000 字`);
		// Wait past autosave (1000ms) and verify count stays exact without double-counting.
		await page.waitForTimeout(1200);
		await expect(page.locator('.status-daily-words')).toHaveText(`今天 ${(baselineWords + 5).toLocaleString()} / 目标 3,000 字`);

		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await expect(page.locator('.status-daily-words')).toHaveText(`今天 ${(baselineWords + 3).toLocaleString()} / 目标 3,000 字`);

		// 5. Backspace right after leading indent deletes the whole indent in one press (and pre-indented lines skip extra 2em indent).
		await page.keyboard.insertText('\n　　带缩进的新段');
		const lastLine = page.locator('.editor:visible .cm-line').last();
		await expect(lastLine).toHaveCSS('text-indent', '0px');
		for (let i = 0; i < '带缩进的新段'.length; i++) {
			await page.keyboard.press('ArrowLeft');
		}
		await page.keyboard.press('Backspace');
		await expect(lastLine).toHaveText('带缩进的新段');
	});
});

test('settings window switches all 7 categories, loads legacy settings.json, previews live, and exposes every setting item', async () => {
	await withApp(
		{
			'editor.fontFamily': 'Songti SC',
			'editor.fontSize': 19,
			'editor.centerLine': true,
			'usage.dailyLimitUsd': 3.5,
			'snapshots.intervalMinutes': 15,
		},
		async ({ page, app, data }) => {
			await page.evaluate(() => window.novel.settings.open());
			await expect.poll(() => app.windows().length).toBe(2);
			const settings = app.windows().find((win) => win !== page)!;
			await settings.waitForLoadState('domcontentloaded');

			// Legacy settings.json values were loaded and applied immediately.
			await expect(settings.getByRole('combobox', { name: '字体', exact: true })).toHaveValue('Songti SC');
			await expect(settings.getByRole('slider', { name: '字号', exact: true })).toHaveValue('19');
			await expect(settings.getByRole('switch', { name: '打字机滚动', exact: true })).toBeChecked();
			await expect(page.locator('.editor:visible .cm-scroller')).toHaveCSS('font-size', '19px');

			// Live preview is visible on 编辑器 and updates immediately when changing heading size / centering / line height.
			const preview = settings.getByLabel('预览');
			await expect(preview).toBeVisible();
			await settings.getByRole('switch', { name: '标题居中', exact: true }).click();
			await expect(preview.locator('.preview-heading')).toHaveCSS('text-align', 'center');
			await expect(page.locator('.editor:visible')).toHaveClass(/heading-center/);

			await settings.getByRole('radiogroup', { name: '行距' }).getByRole('radio', { name: '松', exact: true }).click();
			await expect(preview).toHaveAttribute('style', /--writing-lh:\s*2\.25/);

			// Switch across all 7 categories and verify every single setting label from settingGroups is present.
			const categoryTitles: Record<string, string> = zh.settingsCategories;
			for (const [catId, catTitle] of Object.entries(categoryTitles)) {
				await settings.getByRole('tab', { name: catTitle, exact: true }).click();
				await expect(settings.locator('.settings-pane-title')).toHaveText(catTitle);
				if (catId === 'editor' || catId === 'appearance') {
					await expect(preview).toBeVisible();
				} else {
					await expect(preview).toHaveCount(0);
				}
				const expectedKeys = settingGroups.filter((g) => g.category === catId).flatMap((g) => g.keys);
				for (const key of expectedKeys) {
					const labelText = zh.settingLabels[key];
					await expect(settings.locator('.settings-pane .settings-label').getByText(labelText, { exact: true }).first()).toBeVisible();
				}
			}

			// Appearance category switches dark/light theme in both Settings window and book window.
			await settings.getByRole('tab', { name: '外观', exact: true }).click();
			await settings.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '暗', exact: true }).click();
			await expect(settings.locator('body')).toHaveCSS('background-color', 'rgb(27, 27, 27)');
			await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(27, 27, 27)');
			await settings.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '亮', exact: true }).click();
			await expect(settings.locator('body')).toHaveCSS('background-color', 'rgb(251, 250, 247)');

			// Keyboard navigation on category tablist works.
			const appearanceTab = settings.getByRole('tab', { name: '外观', exact: true });
			await appearanceTab.focus();
			await settings.keyboard.press('ArrowDown');
			await expect(settings.locator('.settings-pane-title')).toHaveText('续写');

			// Usage category shows pre-loaded legacy dailyLimitUsd = $3.5.
			await settings.getByRole('tab', { name: '用量', exact: true }).click();
			await expect(settings.getByRole('slider', { name: '每日上限（美元，0 为不限）', exact: true })).toHaveValue('3.5');

			// iCloud category displays folder constant from code (not hardcoded) and reveal button.
			await settings.getByRole('tab', { name: 'iCloud', exact: true }).click();
			await expect(settings.locator('.settings-pane')).toContainText(`iCloud Drive/${ICLOUD_BOOKS_FOLDER}`);
			await expect(settings.getByRole('button', { name: '在访达中显示', exact: true })).toBeVisible();

			// About category displays app name and version from Electron app.
			await settings.getByRole('tab', { name: '关于', exact: true }).click();
			const expectedVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version as string;
			await expect(settings.locator('.settings-pane')).toContainText(expectedVersion);

			// Saved settings.json retains updated values.
			const saved = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
			expect(saved['editor.headingCenter']).toBe(true);
			expect(saved['editor.lineHeight']).toBe('loose');
			expect(saved['appearance.theme']).toBe('light');
		},
	);
});

test('assistant usage records tokens and cumulative cost delta, lists separately in report, and sums in status bar', async () => {
	await withApp(
		{
			'usage.prices': {
				'test-model': { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
			},
			'assistant.agent': 'custom',
			'assistant.command': process.execPath,
			'assistant.args': [
				'--experimental-strip-types',
				resolve('src/test/fakeAgent.ts'),
				'--options',
				'--close',
				'--models=fable:Fable 5.2,opus:Opus 4.6',
			],
		},
		async ({ page, data }) => {
			// 1. Trigger one manual continuation: 2000 input * $10/1M + 50 output * $20/1M = $0.020 + $0.001 = $0.0210.
			await page.locator('.editor:visible .cm-content').click();
			await page.keyboard.press('Meta+ArrowDown');
			await page.keyboard.press('Alt+Backslash');
			await expect(page.locator('.ghost-text')).toContainText('海风吹过第1道石阶。');
			await page.keyboard.press('Escape');

			// 2. Trigger one outline position relocation: 1000 input * $10/1M + 20 output * $20/1M = $0.010 + $0.0004 = $0.0104.
			await page.getByRole('button', { name: '让 AI 重新定位', exact: true }).click();
			await expect(page.locator('.statusbar button').filter({ hasText: '今天 2 次 · $0.0314' })).toBeVisible();

			// 3. Run two assistant turns via fakeAgent reporting cumulative session cost ($0.12 then $0.30 -> net $0.3000) and 4 token counts.
			await page.locator('.sidebar.right .segments').getByRole('button', { name: '助手', exact: true }).click();
			await expect(page.locator('.assistant-option-trigger')).toContainText('Fable 5.2');

			const input = page.getByRole('textbox', { name: '给助手的消息' });
			await input.fill('cost 0.12\nusage 4000 1500 100000 2000\nsay 第一轮回答');
			await page.getByRole('button', { name: '发送', exact: true }).click();
			await expect(page.locator('.assistant-reply').first()).toContainText('第一轮回答');

			await input.fill('cost 0.30\nusage 5812 4830 302118 500\nsay 第二轮回答');
			await page.getByRole('button', { name: '发送', exact: true }).click();
			await expect(page.locator('.assistant-reply').last()).toContainText('第二轮回答');

			// Status bar sums all three: 1 continuation + 1 position + 2 assistant = 4 requests; $0.0210 + $0.0104 + $0.3000 = $0.3314.
			const statusUsageBtn = page.locator('.statusbar button').filter({ hasText: '今天 4 次 · $0.3314' });
			await expect(statusUsageBtn).toBeVisible();

			// Verify ledger on disk has separate keys.
			const ledger = JSON.parse(await readFile(join(data, 'usage', 'usage.json'), 'utf8')) as Record<string, Record<string, unknown>>;
			const todayEntries = Object.values(ledger)[0];
			expect(Object.keys(todayEntries).sort()).toEqual([
				'Fable 5.2#assistant',
				'openaiCompatible/test-model',
				'openaiCompatible/test-model#position',
			]);

			// Open usage report and check separate rows, Total row, and Claude Code subscription note.
			await statusUsageBtn.click();
			const reportView = page.locator('.report-view:visible');
			await expect(reportView.locator('h1')).toHaveText('用量和估算花费');
			const todayTable = reportView.locator('table').first();
			await expect(todayTable).toContainText('openaiCompatible/test-model');
			await expect(todayTable).toContainText('openaiCompatible/test-model · 大纲定位');
			await expect(todayTable).toContainText('Fable 5.2 · 助手');
			await expect(todayTable).toContainText('合计');
			await expect(todayTable).toContainText('$0.3314');
			await expect(reportView).toContainText('助手走本机的 Claude Code；用订阅登录时，金额是按 API 价格折算的参考值，不是实际扣费。');
		},
	);
});
