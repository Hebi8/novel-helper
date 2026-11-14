import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const command = (...parts: string[]) => JSON.stringify(parts);
async function withBook(
	run: (fixture: {
		app: ElectronApplication;
		page: Page;
		book: string;
		data: string;
		root: string;
		original: string;
		pidFile: string;
		closeApp: () => Promise<void>;
	}) => Promise<void>,
	flags: string[] = [],
	options: { openAssistant?: boolean } = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'novel-assistant-e2e-'));
	const book = join(root, 'book');
	const data = join(root, 'data');
	const pidFile = join(root, 'agent.pid');
	await cp(resolve('examples'), book, { recursive: true });
	await mkdir(data);
	await writeFile(join(data, 'windows.json'), JSON.stringify({ open: [], recent: [], books: {} }));
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			enabled: false,
			'assistant.agent': 'custom',
			'assistant.command': process.execPath,
			'assistant.args': [
				'--experimental-strip-types',
				resolve('src/test/fakeAgent.ts'),
				'--resume',
				'--close',
				`--pid=${pidFile}`,
				...flags,
			],
		}),
	);
	const original = await readFile(join(book, chapter), 'utf8');
	const launchEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'),
	);
	let app: ElectronApplication | undefined;
	let exited: Promise<void> | undefined;
	const closeApp = async () => {
		if (!app) {
			return;
		}
		const current = app;
		const currentExited = exited;
		app = undefined;
		exited = undefined;
		await current.close();
		await currentExited;
	};
	try {
		app = await electron.launch({ env: launchEnv, args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`] });
		exited = new Promise((resolve) => app!.process().once('exit', () => resolve()));
		const welcome = await app.firstWindow();
		await expect(welcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
		const next = app.waitForEvent('window');
		await welcome.evaluate((root) => window.novel.book.open(root), book);
		const page = await next;
		await page.waitForLoadState('domcontentloaded');
		await page
			.getByRole('tree', { name: '章节', exact: true })
			.getByRole('button', { name: /第2章 灯塔/ })
			.click();
		await expect(page.locator('.writing .cm-content')).toContainText('林小满');
		if (options.openAssistant !== false) {
			await page.getByRole('button', { name: '助手', exact: true }).click();
		}
		await run({ app, page, book, data, root, original, pidFile, closeApp });
	} finally {
		await closeApp();
		await rm(root, { recursive: true, force: true });
	}
}
async function send(page: Page, text: string) {
	await page.getByRole('textbox', { name: '给助手的消息' }).fill(text);
	await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function idle(page: Page) {
	await expect.poll(() => page.evaluate(async () => (await window.novel.assistant.state()).busy)).toBe(false);
}

test('assistant changes the open chapter, shows its diff, restores and undoes, denies an outside write, and respects composition', async () => {
	await withBook(async ({ app, page, book, root, original }) => {
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true);
		const revised = '灯塔的新正文。\n林小满推开了门。\n';
		await send(page, command('write', chapter, revised) + '\nsay 已改好灯塔');
		await expect(page.locator('.assistant-reply')).toContainText('已改好灯塔');
		await expect(page.locator('.assistant-turn').first()).toContainText(chapter);
		await expect(page.locator('.assistant-writing, .writing .cm-content').first()).toContainText('灯塔的新正文。');
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(revised);
		await idle(page);
		await page
			.getByRole('button', { name: `看差异 · ${chapter}`, exact: true })
			.first()
			.click();
		const diff = page.getByRole('dialog', { name: `看差异 · ${chapter}`, exact: true });
		await expect(diff.locator('.cm-mergeView')).toBeVisible();
		await expect(diff.locator('.cm-content').last()).toContainText('灯塔的新正文。');
		expect(await diff.locator('.cm-content').first().getAttribute('contenteditable')).toBe('false');
		await expect(diff.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(diff).toHaveCount(0);
		await page.getByRole('button', { name: '退回到这一轮之前', exact: true }).first().click();
		await expect(page.getByRole('dialog', { name: '退回到这一轮之前', exact: true })).toBeVisible();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(original);
		await expect(page.locator('.writing .cm-content')).toContainText('林小满');
		await page.getByRole('button', { name: '撤销这次退回', exact: true }).click();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(revised);
		await expect(page.locator('.writing .cm-content')).toContainText('灯塔的新正文。');
		await send(page, 'ask edit ../outside.txt');
		const permission = page.locator('.assistant-permission').last();
		await expect(permission).toBeVisible();
		expect(await permission.getByRole('button').allTextContents()).toEqual(['允许这一次', '不允许']);
		expect(existsSync(join(root, 'outside.txt'))).toBe(false);
		await permission.getByRole('button', { name: '不允许', exact: true }).click();
		await idle(page);
		expect(existsSync(join(root, 'outside.txt'))).toBe(false);
		const input = page.getByRole('textbox', { name: '给助手的消息' });
		await input.fill('say 组字时不发送');
		const messages = await page.locator('.assistant-user').count();
		await input.dispatchEvent('compositionstart', { data: 'zu' });
		await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true });
		await expect(input).toHaveValue('say 组字时不发送');
		expect(await page.locator('.assistant-user').count()).toBe(messages);
		expect((await page.evaluate(() => window.novel.assistant.state())).busy).toBe(false);
		await input.dispatchEvent('compositionend', { data: '' });
		await input.press('Enter');
		await expect(page.locator('.assistant-reply').last()).toHaveText('组字时不发送');
	});
});

test('sending flushes unsaved text; snapshots survive a cleared conversation and a hidden sidebar', async () => {
	await withBook(async ({ page, book, original }) => {
		const editor = page.locator('.writing .cm-content');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('尚未自动保存。');
		await send(page, command('fsread', chapter));
		await expect(page.locator('.assistant-reply').last()).toContainText('尚未自动保存。');
		await idle(page);
		expect(await readFile(join(book, chapter), 'utf8')).toBe(original + '尚未自动保存。');
		await send(page, command('write', chapter, '保存后的助手稿'));
		await expect(page.locator('.assistant-turn').last()).toContainText('本轮改动');
		await idle(page);
		await page.getByRole('button', { name: '＋ 新会话', exact: true }).click();
		await expect(page.locator('.assistant-user')).toHaveCount(0);
		await page.getByRole('button', { name: '收起右栏', exact: true }).click();
		await page.getByRole('button', { name: '快照', exact: true }).click();
		const history = page.getByRole('dialog', { name: '快照', exact: true });
		await expect(history).toContainText(chapter);
		await history.getByRole('button', { name: '退回到这一轮之前', exact: true }).click();
		await page.getByRole('button', { name: '确认退回', exact: true }).click();
		await expect.poll(() => readFile(join(book, chapter), 'utf8')).toBe(original + '尚未自动保存。');
	});
});

test('closing a book stops its custom agent process', async () => {
	await withBook(async ({ app, page, pidFile }) => {
		await send(page, 'say 正在等\nwait');
		await expect(page.locator('.assistant-reply')).toHaveText('正在等');
		const pid = Number(await readFile(pidFile, 'utf8'));
		await app.evaluate(({ BrowserWindow }) => {
			new BrowserWindow({ show: false });
		});
		const closed = page.waitForEvent('close');
		await page.evaluate(() => window.novel.window.close());
		await closed;
		await expect
			.poll(() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(false);
	});
});

test('an unresolved editor conflict offers a diff and prevents sending an assistant message', async () => {
	await withBook(async ({ page, book }) => {
		const editor = page.locator('.writing .editor .cm-content');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('未保存的我的版本。');
		await writeFile(join(book, chapter), '磁盘上的另一个版本。');
		const conflict = page.locator('.writing .notice').filter({ hasText: '磁盘上的文件已更改' });
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: '看差异', exact: true }).click();
		const diff = page.getByRole('dialog', { name: `看差异 · ${chapter}`, exact: true });
		await expect(diff.locator('.cm-content').first()).toContainText('未保存的我的版本。');
		await expect(diff.locator('.cm-content').last()).toContainText('磁盘上的另一个版本。');
		await page.keyboard.press('Escape');
		await send(page, 'say 冲突解决前不能发送');
		await expect(page.getByRole('alert').filter({ hasText: '有文件未保存或冲突尚未解决' })).toBeVisible();
		expect((await page.evaluate(() => window.novel.assistant.state())).items.filter((item) => item.kind === 'user')).toHaveLength(0);
		expect(await readFile(join(book, chapter), 'utf8')).toBe('磁盘上的另一个版本。');
		await conflict.getByRole('button', { name: '用磁盘的', exact: true }).click();
	});
});

test('the context banner follows editor cursor and selection before typing a message, and sends that selection', async () => {
	await withBook(async ({ page }) => {
		const editor = page.locator('.writing .editor .cm-content');
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.insertText('第一行\n林小满走来\n第三行');
		await page.keyboard.press('Meta+ArrowUp');
		await expect(page.locator('.assistant-context')).toContainText('第 1 行');
		await page.keyboard.press('ArrowDown');
		await expect(page.locator('.assistant-context')).toContainText('第 2 行');
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('Shift+ArrowRight');
		}
		await expect(page.locator('.assistant-context')).toContainText('选中 3 字 林小满');
		await send(page, 'echo');
		await expect(page.locator('.assistant-reply')).toContainText('选中了第 2 行第 1 列到第 2 行第 4 列');
		await idle(page);
		const items = (await page.evaluate(() => window.novel.assistant.state())).items;
		const answer = items.flatMap((item) => (item.kind === 'agent' ? [item.text] : [])).join('');
		expect(answer).toContain(`当前打开的文件：${chapter}`);
		expect(answer).toContain('<selection>\n林小满\n</selection>');
	});
});

test('stopping during agent startup restores the unsent draft without adding a user message', async () => {
	await withBook(
		async ({ page, pidFile }) => {
			const text = 'say 启动期间停止后还要保留的消息';
			await send(page, text);
			await expect(page.getByRole('status').filter({ hasText: '正在启动助手' })).toBeVisible();
			await expect.poll(() => existsSync(pidFile)).toBe(true);
			const input = page.getByRole('textbox', { name: '给助手的消息' });
			await expect(input).toHaveValue('');
			await page.getByRole('button', { name: '停止', exact: true }).click();
			await idle(page);
			await expect(input).toHaveValue(text);
			await expect(page.locator('.assistant-user')).toHaveCount(0);
			await send(page, text);
			await expect(page.getByRole('status').filter({ hasText: '正在启动助手' })).toBeVisible();
			await input.fill('后来输入的草稿');
			await page.getByRole('button', { name: '停止', exact: true }).click();
			await idle(page);
			await expect(input).toHaveValue('后来输入的草稿');
		},
		['--init-hangs'],
	);
});

test('assistant model and effort popover fetches options on first show, switches via popover, and stays lazy when cached', async () => {
	await withBook(
		async ({ page, data, pidFile, closeApp }) => {
			// Hidden assistant panel does not start the agent.
			expect(existsSync(pidFile)).toBe(false);

			const composer = page.locator('.assistant-composer');
			const trigger = composer.locator('.assistant-option-trigger');
			const input = page.getByRole('textbox', { name: '给助手的消息' });

			await page.getByRole('button', { name: '助手', exact: true }).click();
			// Disabled empty placeholder while fetching options in background, with no loading text and no dropdowns.
			await expect(trigger).toBeVisible();
			await expect(trigger).toBeDisabled();
			await expect(trigger).toHaveText('');
			await expect(composer.getByRole('combobox')).toHaveCount(0);

			// Once session/new finishes (without sending any message), button shows model name + effort name.
			await expect(trigger).toBeEnabled();
			await expect(trigger).toHaveText('Default (recommended) Medium');
			await expect(page.locator('.assistant-user')).toHaveCount(0);
			expect(existsSync(pidFile)).toBe(true);

			// Open popover: upper model list with descriptions & checkmark, lower segmented effort buttons; ignored categories hidden.
			await trigger.click();
			const popover = composer.getByRole('dialog', { name: '模型', exact: true });
			await expect(popover).toBeVisible();
			await expect(popover).not.toContainText('Ultracode');
			await expect(popover).not.toContainText('Plan');
			await expect(popover.locator('.assistant-model-item').filter({ hasText: 'Fable 5.2' }).locator('small')).toHaveText(
				'Balanced writing model',
			);
			await expect(popover.locator('.assistant-model-item[aria-pressed="true"]')).toContainText('Default (recommended)');
			await expect(popover.locator('.assistant-model-item[aria-pressed="true"] .assistant-model-check')).toHaveText('✓');

			// Changing effort updates immediately and keeps the popover open.
			const effortGroup = popover.getByRole('group', { name: '强度', exact: true });
			await expect(effortGroup.getByRole('button', { name: 'Medium', exact: true })).toHaveAttribute('aria-pressed', 'true');
			await effortGroup.getByRole('button', { name: 'High', exact: true }).click();
			await expect(popover).toBeVisible();
			await expect(trigger).toHaveText('Default (recommended) High');
			await expect(effortGroup.getByRole('button', { name: 'High', exact: true })).toHaveAttribute('aria-pressed', 'true');

			// Selecting a model updates, closes the popover, and returns focus to the input.
			await popover.locator('.assistant-model-item').filter({ hasText: 'Fable 5.2' }).click();
			await expect(popover).toHaveCount(0);
			await expect(trigger).toHaveText('Fable 5.2 High');
			await expect(input).toBeFocused();

			// Escape closes the popover and returns focus to the input.
			await trigger.click();
			await expect(popover).toBeVisible();
			await expect(popover.locator('.assistant-model-item[aria-pressed="true"]')).toContainText('Fable 5.2');
			await page.keyboard.press('Escape');
			await expect(popover).toHaveCount(0);
			await expect(input).toBeFocused();

			// Clicking outside closes the popover and returns focus to the input.
			await trigger.click();
			await expect(popover).toBeVisible();
			await page.locator('.assistant-heading strong').click();
			await expect(popover).toHaveCount(0);
			await expect(input).toBeFocused();

			await send(page, 'config');
			await expect(page.locator('.assistant-reply').last()).toHaveText('model=fable[1m] effort=high');
			await idle(page);

			// Disabled while a turn is running.
			await send(page, 'say 处理中\nwait');
			await expect(page.locator('.assistant-reply').last()).toHaveText('处理中');
			await expect(trigger).toBeDisabled();
			await page.getByRole('button', { name: '停止', exact: true }).click();
			await idle(page);
			await expect(trigger).toBeEnabled();

			// Relaunch with cached options: showing the assistant panel does NOT start the agent until a message is sent.
			await closeApp();
			await rm(pidFile, { force: true });

			const launchEnv = Object.fromEntries(
				Object.entries(process.env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
				),
			);
			const secondApp = await electron.launch({
				env: launchEnv,
				args: [resolve('dist/main/index.js'), '--test-mode', `--user-data-dir=${data}`],
			});
			const secondExited = new Promise<void>((resolveExit) => secondApp.process().once('exit', () => resolveExit()));
			try {
				const secondPage = await secondApp.firstWindow();
				await secondPage.waitForLoadState('domcontentloaded');
				await secondPage.getByRole('button', { name: '助手', exact: true }).click();
				const secondTrigger = secondPage.locator('.assistant-composer .assistant-option-trigger');
				await expect(secondTrigger).toHaveText('Fable 5.2 High');
				await secondPage.waitForTimeout(150);
				expect(existsSync(pidFile)).toBe(false);

				await secondTrigger.click();
				await secondPage
					.locator('.assistant-composer')
					.getByRole('group', { name: '强度', exact: true })
					.getByRole('button', { name: 'Max', exact: true })
					.click();
				await secondPage.keyboard.press('Escape');
				await expect(secondTrigger).toHaveText('Fable 5.2 Max');
				expect(existsSync(pidFile)).toBe(false);

				await send(secondPage, 'config');
				await expect(secondPage.locator('.assistant-reply').last()).toHaveText('model=fable[1m] effort=max');
				expect(existsSync(pidFile)).toBe(true);
				await idle(secondPage);
			} finally {
				await secondApp.close();
				await secondExited;
			}
		},
		[
			'--options',
			'--slow-open',
			'--models=default:Default (recommended),fable[1m]:Fable 5.2:Balanced writing model,opus:Opus 5.5:Deep reasoning',
			'--efforts=default:Default,low:Low,medium:Medium,high:High,xhigh:XHigh,max:Max',
		],
		{ openAssistant: false },
	);
});
