import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, rename, lstat, readlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentClient, CLAUDE_ADAPTER } from '../acp/client';
import { AssistantService } from '../main/assistant/service';
import { AssistantRegistry } from '../main/assistant/registry';
import { cachedLoginPath } from '../main/assistant/environment';
import { storyNames } from '../main/assistant/names';
import { BookIndex } from '../main/book/indexer';
import { SettingsStore } from '../main/settings/store';
import { changeKind, MAX_FILE_BYTES, type Change } from '../core/snapshot';
import type { Item } from '../core/transcript';
import type { StoryNames } from '../core/scaffold';
import { filesIn } from './files';

const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const removed = '摘要/第1章 雾里来信.md';
const added = '摘要/助手新增.md';
const fakeAgent = join(__dirname, 'fakeAgent.js');
const command = (...parts: string[]) => JSON.stringify(parts);
type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;
const itemsOf = <K extends Item['kind']>(service: AssistantService, kind: K): Of<K>[] =>
	service.state().items.filter((item): item is Of<K> => item.kind === kind);
const said = (service: AssistantService) => {
	const items = service.state().items;
	const last = items.map((item) => item.kind).lastIndexOf('user');
	return items
		.slice(last)
		.flatMap((item) => (item.kind === 'agent' ? [item.text] : []))
		.join('');
};
async function until<T>(get: () => T | undefined | false, description: string): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const result = get();
		if (result) {
			return result;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}
async function fixture(t: TestContext, flags: string[] = []) {
	const root = await mkdtemp(join(tmpdir(), 'novel-assistant-'));
	const book = join(root, 'book');
	const userData = join(root, 'data');
	await cp(resolve('examples'), book, { recursive: true });
	const settings = new SettingsStore(userData);
	settings.set('assistant.agent', 'custom');
	settings.set('assistant.command', process.execPath);
	settings.set('assistant.args', [fakeAgent, ...flags]);
	const index = new BookIndex(book);
	await index.load();
	const services: AssistantService[] = [];
	const open = async (root = book, names: () => Promise<StoryNames> = () => storyNames(index)) => {
		const service = new AssistantService({ root, userData, settings: () => settings.get(), names, environment: async () => {} });
		services.push(service);
		await service.load();
		return service;
	};
	t.after(async () => {
		for (const service of services) {
			await service.dispose();
		}
		index.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const service = await open();
	return { root, book, userData, service, settings, index, open };
}
async function manuscript(book: string): Promise<Record<string, Buffer>> {
	const entries = await Promise.all(
		filesIn(book)
			.filter((path) => !path.startsWith('.novel-helper/snapshots/'))
			.map(async (path) => [path, await readFile(join(book, path))] as const),
	);
	return Object.fromEntries(entries);
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test('assistant streams replies and tools, and snapshots list added, modified and removed files', async (t) => {
	const { service, book } = await fixture(t);
	const changed: Change[][] = [];
	service.onTurnEnded((files) => changed.push(files));
	await service.send(
		[
			'think 先看看',
			command('write', chapter, '灯塔的新正文。\r\n'),
			command('write', added, '新增摘要'),
			command('delete', removed),
			'say 改好了',
		].join('\n'),
	);
	assert.equal(said(service), '改好了');
	assert.equal(itemsOf(service, 'thought')[0].text, '先看看');
	assert.deepEqual(
		itemsOf(service, 'tool').map((item) => item.status),
		['completed', 'completed', 'completed'],
	);
	const turn = itemsOf(service, 'turn')[0];
	assert.equal(turn.stop, 'end_turn');
	assert.deepEqual(Object.fromEntries(turn.changes.map((change) => [change.path, changeKind(change)])), {
		[chapter]: 'modified',
		[added]: 'added',
		[removed]: 'removed',
	});
	assert.equal((await service.history()).length, 1);
	assert.deepEqual(changed, [turn.changes]);
	assert.deepEqual(await readFile(join(book, chapter)), Buffer.from('灯塔的新正文。\r\n'));
	assert.equal(service.state().busy, false);
});

test('a turn without file changes leaves no snapshot', async (t) => {
	const { service } = await fixture(t);
	await service.send('say 这一章节奏不错');
	assert.deepEqual(await service.history(), []);
	assert.deepEqual(itemsOf(service, 'turn'), [{ kind: 'turn', stop: 'end_turn', changes: [] }]);
});

test('restore and undo restore preserve every byte, including later manual edits and files', async (t) => {
	const { service, book } = await fixture(t);
	const before = await manuscript(book);
	const reverted: Change[][] = [];
	service.onReverted((files) => reverted.push(files));
	await service.send([command('write', chapter, '第一轮\r\n'), command('write', added, '摘要\n'), command('delete', removed)].join('\n'));
	await writeFile(join(book, chapter), '\ufeff后来手改\r\n第二行\r\n');
	await writeFile(join(book, '手写笔记.txt'), '后来的新文件\r');
	const after = await manuscript(book);
	const record = itemsOf(service, 'turn')[0].record!;
	assert.deepEqual((await service.revert(record)).blocked, []);
	assert.deepEqual(await manuscript(book), before);
	const undo = itemsOf(service, 'turn').at(-1)!;
	assert.equal(undo.stop, 'reverted');
	assert.equal(undo.target, record);
	assert.deepEqual(reverted, [undo.changes]);
	await service.send('echo');
	assert.match(said(service), /作者刚把故事目录退回/);
	await service.revert(undo.record!);
	assert.deepEqual(await manuscript(book), after);
});

test('restore blockers leave every other file untouched and identify all blocked paths', async (t) => {
	const { service, book, root } = await fixture(t);
	const paths = ['正文/binary.md', '正文/large.md', '正文/link.md', '正文/taken.md'];
	for (const path of paths) {
		await writeFile(join(book, path), '之前');
	}
	await service.send([...paths.map((path) => command('write', path, '之后')), command('write', chapter, '不能部分退回')].join('\n'));
	await writeFile(join(book, paths[0]), Buffer.from([80, 75, 0, 1]));
	await writeFile(join(book, paths[1]), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
	await rm(join(book, paths[2]));
	await writeFile(join(root, 'outside.md'), '外面的原文');
	await symlink(join(root, 'outside.md'), join(book, paths[2]));
	await rm(join(book, paths[3]));
	await mkdir(join(book, paths[3]));
	const before = await manuscript(book);
	const result = await service.revert(itemsOf(service, 'turn')[0].record!);
	assert.deepEqual(Object.fromEntries(result.blocked.map(({ path, why }) => [path, why])), {
		[paths[0]]: 'binary',
		[paths[1]]: 'large',
		[paths[2]]: 'link',
		[paths[3]]: 'taken',
	});
	assert.deepEqual(await manuscript(book), before);
	assert.equal(await readFile(join(root, 'outside.md'), 'utf8'), '外面的原文');
	assert.equal(itemsOf(service, 'turn').length, 1);
});

test('story permissions allow prose and non-snapshot metadata without a question', async (t) => {
	const { service, book } = await fixture(t);
	await service.send('ask edit 正文/新章.md\nask read 正文/新章.md\nask edit .novel-helper/templates/人物.md');
	assert.equal(said(service), 'answer: yesanswer: yesanswer: yes');
	assert.deepEqual(itemsOf(service, 'ask'), []);
	assert.equal(await readFile(join(book, '.novel-helper/templates/人物.md'), 'utf8'), 'asked');
	await service.revert(itemsOf(service, 'turn')[0].record!);
	assert.equal(existsSync(join(book, '.novel-helper/templates/人物.md')), false);
});

test('outside paths, commands, hidden folders and snapshots ask only once or reject; stopping settles unanswered permission', async (t) => {
	const { service, root, book } = await fixture(t);
	for (const text of [
		'ask edit ../outside.txt',
		'run echo hello',
		'ask edit .git/config',
		'ask edit .novel-helper/snapshots/do-not-write.txt',
	]) {
		const count = itemsOf(service, 'ask').length;
		const running = service.send(text);
		const ask = await until(() => itemsOf(service, 'ask')[count], 'permission');
		assert.deepEqual(
			ask.options.map((option) => option.kind),
			['allow_once', 'reject_once'],
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(service.state().busy, true);
		assert.equal(existsSync(join(root, 'outside.txt')), false);
		service.stop();
		await running;
		assert.equal(itemsOf(service, 'ask')[count].closed, true);
	}
	assert.equal(existsSync(join(book, '.git/config')), false);
	assert.equal(existsSync(join(book, '.novel-helper/snapshots/do-not-write.txt')), false);
	const running = service.send('ask edit ../outside.txt');
	const ask = await until(() => itemsOf(service, 'ask').find((item) => !item.answer && !item.closed), 'next permission');
	service.answer(ask.id, false);
	await running;
	assert.equal(existsSync(join(root, 'outside.txt')), false);
	assert.equal(said(service), 'answer: no');
});

test('permissions resolve symbolic links and ask for binary files and directories', async (t) => {
	const { service, root, book } = await fixture(t);
	await writeFile(join(root, 'outside.txt'), 'outside');
	await symlink(join(root, 'outside.txt'), join(book, 'linked.txt'));
	await writeFile(join(book, 'binary.txt'), Buffer.from([0, 1]));
	await mkdir(join(book, 'directory'));
	for (const path of ['linked.txt', 'binary.txt', 'directory']) {
		const running = service.send(`ask edit ${path}`);
		const ask = await until(() => itemsOf(service, 'ask').find((item) => !item.answer && !item.closed), path);
		service.answer(ask.id, false);
		await running;
	}
	assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'outside');
	assert.equal(itemsOf(service, 'ask').length, 3);
});

test('client filesystem operations read and atomically write inside, while outside access requires an answer', async (t) => {
	const { service, root, book } = await fixture(t);
	await service.send(command('fswrite', chapter, '客户端改的\n') + '\n' + command('fsread', chapter));
	assert.match(said(service), /客户端改的/);
	assert.equal(await readFile(join(book, chapter), 'utf8'), '客户端改的\n');
	await writeFile(join(root, 'outside.txt'), '外面');
	for (const text of ['fsread ../outside.txt', 'fswrite ../outside.txt 不该写']) {
		const running = service.send(text);
		const ask = await until(() => itemsOf(service, 'ask').find((item) => !item.answer && !item.closed), 'filesystem permission');
		service.answer(ask.id, false);
		await running;
	}
	assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), '外面');
	const running = service.send('fswrite ../outside.txt 允许这一次');
	const ask = await until(() => itemsOf(service, 'ask').find((item) => !item.answer && !item.closed), 'allowed filesystem permission');
	service.answer(ask.id, true);
	await running;
	assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), '允许这一次');
});

test('diff uses the recorded before and after; opening is offered only while the disk still matches', async (t) => {
	const { service, book } = await fixture(t);
	const original = await readFile(join(book, chapter), 'utf8');
	const deleted = await readFile(join(book, removed), 'utf8');
	await service.send([command('write', chapter, '新稿'), command('write', added, '新摘要'), command('delete', removed)].join('\n'));
	const id = itemsOf(service, 'turn')[0].record!;
	assert.deepEqual(await service.diff(id, chapter), { path: chapter, before: original, after: '新稿', canOpen: true });
	assert.deepEqual(await service.diff(id, added), { path: added, before: '', after: '新摘要', canOpen: true });
	assert.deepEqual(await service.diff(id, removed), { path: removed, before: deleted, after: '', canOpen: false });
	await writeFile(join(book, chapter), '手改');
	assert.deepEqual(await service.diff(id, chapter), { path: chapter, before: original, after: '新稿', canOpen: false });
	await assert.rejects(service.diff(id, '../outside.txt'));
	await assert.rejects(service.diff(id, join(book, chapter)));
});

test('history survives a new conversation and retention uses application settings', async (t) => {
	const { service, settings } = await fixture(t);
	settings.set('assistant.snapshots.keep', 2);
	for (const text of ['一', '二', '三']) {
		await service.send(command('write', chapter, text));
	}
	await service.newSession();
	assert.deepEqual(service.state().items, []);
	assert.deepEqual((await service.history()).map((record) => record.id).sort(), [2, 3]);
	await assert.rejects(service.diff(1, chapter));
});

test('current file, cursor line and selected text accompany every message; the actual folder names brief the session once', async (t) => {
	const { service: initial, book, index, open } = await fixture(t);
	await initial.dispose();
	await rename(join(book, '正文'), join(book, 'chapters'));
	const renamed = new BookIndex(book);
	await renamed.load();
	t.after(() => renamed.dispose());
	assert.equal((await storyNames(renamed)).chapters, 'chapters');
	assert.equal((await storyNames(index)).outlines, '大纲');
	const service = await open(book, () => storyNames(renamed));
	const current = chapter.replace('正文/', 'chapters/');
	await service.send('echo', {
		path: current,
		line: 2,
		selection: { text: '林小满', startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 },
	});
	assert.match(said(service), /你在帮一位作者写小说/);
	assert.ok(said(service).includes('`chapters/`'));
	assert.ok(said(service).includes(`当前打开的文件：${current}`));
	assert.match(said(service), /第 2 行第 1 列到第 2 行第 4 列/);
	assert.ok(said(service).includes('<selection>\n林小满\n</selection>'));
	await service.send('echo', { path: current, line: 7 });
	assert.doesNotMatch(said(service), /你在帮一位作者写小说/);
	assert.match(said(service), /光标在第 7 行/);
	await assert.rejects(service.send('echo', { path: '../outside.txt', line: 1 }));
});

test('system-prompt capable agents receive the brief there and no repeated brief in messages', async (t) => {
	const { service } = await fixture(t, ['--system-prompt']);
	await service.send('system');
	assert.match(said(service), /你在帮一位作者写小说/);
	assert.match(said(service), /`正文\//);
	await service.send('echo');
	assert.equal(said(service), '');
});

test('stop cancels the turn; new conversation first cancels, closes the old session and clears the panel', async (t) => {
	const { service } = await fixture(t, ['--close']);
	await service.send('session');
	const previous = said(service).split(' ')[0];
	let running = service.send('say 开始\nwait');
	await until(() => said(service) === '开始', 'stream');
	service.stop();
	await running;
	assert.equal(itemsOf(service, 'turn').at(-1)?.stop, 'cancelled');
	running = service.send('say 再开始\nwait');
	await until(() => said(service) === '再开始', 'second stream');
	await service.newSession();
	await running;
	assert.deepEqual(service.state().items, []);
	await service.send('session');
	assert.notEqual(said(service).split(' ')[0], previous);
	assert.ok(said(service).includes(`closed=${previous}`));
});

test('agent exit records its partial changes and stderr, and the next message resumes the session', async (t) => {
	const { service, userData } = await fixture(t, ['--resume']);
	await service.send('session');
	const previous = said(service).split(' ')[0];
	await service.send(command('write', chapter, '半稿') + '\nstderr partial failure\nexit 7');
	const turn = itemsOf(service, 'turn').at(-1)!;
	assert.equal(turn.stop, 'failed');
	assert.deepEqual(
		turn.changes.map((change) => change.path),
		[chapter],
	);
	const notices = itemsOf(service, 'notice');
	assert.ok(notices.some((notice) => notice.level === 'error' && /退出|结束/.test(notice.text)));
	assert.ok(notices.some((notice) => notice.detail?.includes('partial failure')));
	const logs = filesIn(userData).filter((file) => file.endsWith('.log'));
	assert.ok(logs.length);
	assert.ok(
		(await Promise.all(logs.map((file) => readFile(join(userData, file), 'utf8')))).some((text) => text.includes('partial failure')),
	);
	await service.send('session');
	assert.equal(said(service).split(' ')[0], previous);
});

test('missing commands, unauthenticated agents and immediate exit have distinct explanations', async (t) => {
	const missing = await fixture(t);
	missing.settings.set('assistant.command', join(missing.root, 'no-such-command'));
	await missing.service.send('say 不会发送');
	assert.match(itemsOf(missing.service, 'notice').at(-1)!.text, /找不到|未找到/);
	assert.deepEqual(itemsOf(missing.service, 'user'), []);
	const auth = await fixture(t, ['--auth']);
	await auth.service.send('say 不会发送');
	assert.match(itemsOf(auth.service, 'notice').at(-1)!.text, /登录/);
	const exited = await fixture(t, ['--exit-on-start']);
	await exited.service.send('say 不会发送');
	assert.match(itemsOf(exited.service, 'notice').at(-1)!.text, /启动/);
	assert.equal(itemsOf(exited.service, 'notice').at(-1)!.detail, 'fake agent could not start');
	const unset = await fixture(t);
	unset.settings.set('assistant.command', ' ');
	await unset.service.send('say 不会发送');
	assert.match(itemsOf(unset.service, 'notice').at(-1)!.text, /命令/);
});

test('disposing the window service stops a running agent and one still initializing', async (t) => {
	for (const flags of [[], ['--init-hangs']]) {
		const fixtureValue = await fixture(t, flags);
		const { root, settings, service } = fixtureValue;
		const pidFile = join(root, 'pid');
		settings.set('assistant.args', [fakeAgent, ...flags, `--pid=${pidFile}`]);
		const running = service.send('say 开始\nwait');
		const pid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'agent pid'));
		assert.equal(alive(pid), true);
		await service.dispose();
		await running;
		await until(() => !alive(pid), 'agent exit');
	}
});

test('transcripts and session ids live under userData per book, survive reopening, and never enter manuscripts', async (t) => {
	const { service, book, userData, open, root } = await fixture(t, ['--resume']);
	const before = filesIn(book);
	await service.send('session\nsay 保留下来的对话');
	const previous = said(service).split(' ')[0];
	const savedItems = service.state().items;
	await service.dispose();
	const file = join(userData, 'assistant', createHash('sha256').update(book).digest('hex') + '.json');
	assert.ok((await readFile(file, 'utf8')).includes(previous));
	assert.deepEqual(
		filesIn(book).filter((file) => !file.startsWith('.novel-helper/snapshots/')),
		before,
	);
	const reopened = await open();
	assert.deepEqual(reopened.state().items, JSON.parse(JSON.stringify(savedItems)));
	await reopened.send('session');
	assert.equal(said(reopened).split(' ')[0], previous);
	const otherBook = join(root, 'other-book');
	await cp(resolve('examples'), otherBook, { recursive: true });
	const other = await open(otherBook);
	assert.deepEqual(other.state().items, []);
	await other.send('say 另一本书');
	assert.equal((await readdir(join(userData, 'assistant'))).filter((name) => name.endsWith('.json')).length, 2);
});

test('reopening with an agent without resume explains that the conversation is new', async (t) => {
	const { service, open } = await fixture(t);
	await service.send('session');
	const previous = said(service).split(' ')[0];
	await service.dispose();
	const reopened = await open();
	await reopened.send('session');
	assert.notEqual(said(reopened).split(' ')[0], previous);
	assert.ok(itemsOf(reopened, 'notice').some((notice) => /新.*会话|新.*对话/.test(notice.text)));
});

test('restore and sending share one exclusion gate', async (t) => {
	const { service, book } = await fixture(t);
	await service.send(command('write', chapter, '新稿'));
	const before = itemsOf(service, 'user').length;
	const restoring = service.revert(itemsOf(service, 'turn')[0].record!);
	await service.send('write 正文/unwanted.md 不应同时写');
	await restoring;
	assert.equal(itemsOf(service, 'user').length, before);
	assert.equal(existsSync(join(book, '正文/unwanted.md')), false);
});

test('a short launch PATH uses the injected login shell path once and finds the custom command', async (t) => {
	const { service, settings } = await fixture(t);
	let calls = 0;
	const login = cachedLoginPath(async () => {
		calls++;
		return dirname(process.execPath) + ':/usr/bin:/bin';
	});
	const previous = process.env.PATH;
	try {
		process.env.PATH = '/no-commands-here';
		const [one, two] = await Promise.all([login(), login()]);
		assert.equal(one, two);
		assert.equal(calls, 1);
		process.env.PATH = one;
		settings.set('assistant.command', basename(process.execPath));
		await service.send('say 找到了');
		assert.equal(said(service), '找到了');
	} finally {
		process.env.PATH = previous;
	}
});

test('the Claude preset pins its adapter and enters the asking mode using the fake agent', async (t) => {
	const { service, settings } = await fixture(t);
	settings.set('assistant.agent', 'claude');
	const start = AgentClient.start;
	t.mock.method(
		AgentClient,
		'start',
		(
			chosen: Parameters<typeof start>[0],
			cwd: Parameters<typeof start>[1],
			handlers: Parameters<typeof start>[2],
			signal: Parameters<typeof start>[3],
		) => {
			assert.deepEqual(chosen, { command: 'npx', args: ['-y', CLAUDE_ADAPTER], mode: 'default' });
			return start({ command: process.execPath, args: [fakeAgent, '--modes'], mode: chosen.mode }, cwd, handlers, signal);
		},
	);
	await service.send('session');
	assert.match(said(service), /mode=default/);
});

test('a missing npx is explained without starting or downloading an adapter', async (t) => {
	const { service, settings, root } = await fixture(t);
	settings.set('assistant.agent', 'claude');
	const previous = process.env.PATH;
	try {
		process.env.PATH = join(root, 'empty-path');
		await service.send('say 不会启动适配器');
		assert.match(itemsOf(service, 'notice').at(-1)!.text, /找不到 npx/);
		assert.deepEqual(itemsOf(service, 'user'), []);
	} finally {
		process.env.PATH = previous;
	}
});

test('client writes through an inside symlink preserve the link and snapshot the target for restore', async (t) => {
	const { service, book } = await fixture(t);
	const original = await readFile(join(book, chapter));
	const alias = 'linked-chapter.md';
	await symlink(chapter, join(book, alias));
	await service.send(command('fswrite', alias, '通过链接改的正文\r\n'));
	assert.deepEqual(itemsOf(service, 'ask'), []);
	assert.equal((await lstat(join(book, alias))).isSymbolicLink(), true);
	assert.equal(await readlink(join(book, alias)), chapter);
	assert.deepEqual(await readFile(join(book, chapter)), Buffer.from('通过链接改的正文\r\n'));
	const turn = itemsOf(service, 'turn').at(-1)!;
	assert.deepEqual(
		turn.changes.map((change) => change.path),
		[chapter],
	);
	await service.revert(turn.record!);
	assert.deepEqual(await readFile(join(book, chapter)), original);
	assert.equal((await lstat(join(book, alias))).isSymbolicLink(), true);
	assert.equal(await readlink(join(book, alias)), chapter);
});

test('existing and dangling external symlinks require permission; denied writes change nothing and approved writes preserve links', async (t) => {
	const { service, book, root } = await fixture(t);
	for (const exists of [true, false]) {
		const name = exists ? 'external' : 'dangling';
		const target = join(root, `${name}.md`);
		const alias = `${name}-link.md`;
		if (exists) {
			await writeFile(target, '外面的原文');
		}
		await symlink(target, join(book, alias));
		let running = service.send(command('fswrite', alias, '未允许的内容'));
		let ask = await until(() => itemsOf(service, 'ask').find((item) => !item.answer && !item.closed), 'linked write permission');
		service.answer(ask.id, false);
		await running;
		assert.equal(existsSync(target), exists);
		if (exists) {
			assert.equal(await readFile(target, 'utf8'), '外面的原文');
		}
		assert.equal((await lstat(join(book, alias))).isSymbolicLink(), true);
		running = service.send(command('fswrite', alias, '明确允许的内容'));
		ask = await until(() => itemsOf(service, 'ask').find((item) => !item.answer && !item.closed), 'approved linked write');
		service.answer(ask.id, true);
		await running;
		assert.equal(await readFile(target, 'utf8'), '明确允许的内容');
		assert.equal((await lstat(join(book, alias))).isSymbolicLink(), true);
		assert.equal(await readlink(join(book, alias)), target);
	}
});

test('registry reopening waits for the old window final transcript while another book opens independently', async (t) => {
	const { service, book, root, open } = await fixture(t, ['--resume']);
	const otherBook = join(root, 'other-book');
	await cp(resolve('examples'), otherBook, { recursive: true });
	const registry = new AssistantRegistry();
	assert.equal(await registry.get(book, async () => service), service);
	const turn = service.send('say 关窗前最后的回复\nwait');
	await until(() => said(service) === '关窗前最后的回复', 'last reply before close');
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const dispose = service.dispose.bind(service);
	t.mock.method(service, 'dispose', async () => {
		await gate;
		await dispose();
	});
	let reloaded = false;
	try {
		const closing = registry.close(book);
		const opening = registry.get(book, async () => {
			reloaded = true;
			return open();
		});
		const other = await registry.get(otherBook, () => open(otherBook));
		await other.send('say 另一本书不必等待');
		assert.equal(said(other), '另一本书不必等待');
		assert.equal(reloaded, false);
		release();
		await closing;
		await turn;
		const reopened = await opening;
		assert.equal(reloaded, true);
		assert.deepEqual(reopened.state().items, JSON.parse(JSON.stringify(service.state().items)));
		assert.equal(itemsOf(reopened, 'turn').length, 1);
		assert.ok(itemsOf(reopened, 'agent').some((item) => item.text === '关窗前最后的回复'));
		const one = reopened.send('say 这一册在等\nwait');
		const two = other.send('say 另一册在等\nwait');
		await until(() => said(reopened) === '这一册在等' && said(other) === '另一册在等', 'both agents waiting');
		await registry.closeAll();
		await Promise.all([one, two]);
		assert.equal(await reopened.send('say 不应重新启动'), false);
		assert.equal(await other.send('say 不应重新启动'), false);
	} finally {
		release();
		await registry.closeAll();
	}
});

test('an older registry close cannot erase a newer close that a third window must wait for', async (t) => {
	const { service, book, open } = await fixture(t);
	const registry = new AssistantRegistry();
	await registry.get(book, async () => service);
	let releaseFirst!: () => void;
	let releaseSecond!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const secondGate = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	const disposeFirst = service.dispose.bind(service);
	t.mock.method(service, 'dispose', async () => {
		await firstGate;
		await disposeFirst();
	});
	let secondClosing = false;
	let thirdCreated = false;
	try {
		const firstClose = registry.close(book);
		void registry.get(book, async () => {
			const second = await open();
			const disposeSecond = second.dispose.bind(second);
			t.mock.method(second, 'dispose', async () => {
				secondClosing = true;
				await secondGate;
				await disposeSecond();
			});
			return second;
		});
		const secondClose = registry.close(book);
		releaseFirst();
		await firstClose;
		await until(() => secondClosing, 'second window close');
		const third = registry.get(book, async () => {
			thirdCreated = true;
			return open();
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(thirdCreated, false);
		releaseSecond();
		await secondClose;
		await third;
		assert.equal(thirdCreated, true);
	} finally {
		releaseFirst();
		releaseSecond();
		await registry.closeAll();
	}
});
