import nativeFs = require('node:fs');
import type { TestContext } from 'node:test';
import fs = require('node:fs/promises');
import { bookPath } from '../main/book/paths';
import { WindowStore } from '../main/window/state';
import { inspectRememberedBook, restoreBooks } from '../main/window/reopen';
import { CloseGate } from '../main/window/closeGate';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BookIndex, inspectBook, findStories } from '../main/book/indexer';
import { atomicWrite } from '../main/book/files';
import { SettingsStore } from '../main/settings/store';
import { CompletionService } from '../main/completion/service';
import { UsageStore } from '../storage/usageStore';
import { fakeServer, stream, openaiText, OPENAI_END, openaiUsage, sleep } from './fakeServer';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
	const root = await mkdtemp(join(tmpdir(), 'novel-main-'));
	const book = join(root, 'book');
	await cp(resolve('examples'), book, { recursive: true });
	const index = new BookIndex(book);
	await index.load();
	t.after(async () => {
		index.dispose();
		await rm(root, { recursive: true, force: true });
	});
	return { root, book, index };
}
test('examples book uses the extension hierarchy, companions, and lore', async (t) => {
	const { index } = await fixture(t);
	assert.equal(await index.usable(), true);
	const tree = index.library.tree();
	assert.equal(tree.name, '全书');
	assert.equal(tree.outline, '大纲/全书.md');
	const volume = tree.children[0];
	assert.equal(volume.name, '第一卷 雾港');
	assert.equal(volume.outline, '大纲/第一卷 雾港.md');
	const arc = volume.children[0];
	assert.equal(arc.name, '第一幕 来信');
	assert.equal(arc.children.length, 2);
	assert.equal(arc.children[1].path, chapter);
	assert.equal(arc.children[1].outline, '大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.md');
	assert.equal(arc.children[0].summary, '摘要/第1章 雾里来信.md');
	assert.equal(index.library.entries().length, 8);
});
test('unusable folders discover marked stories, excluding hidden/dependencies and levels deeper than four', async (t) => {
	const { root, book } = await fixture(t);
	await mkdir(join(book, '.novel-helper'), { recursive: true });
	await writeFile(join(book, '.novel-helper/project.json'), '{"version":1}');
	for (const path of ['nested/one/two/book', 'a/b/c/d/deep', 'node_modules/book', '.hidden/book']) {
		await mkdir(join(root, path, '.novel-helper'), { recursive: true });
		await writeFile(join(root, path, '.novel-helper/project.json'), '{"version":1}');
	}
	const result = await inspectBook(root);
	assert.equal(result.index, undefined);
	assert.deepEqual(await findStories(root), [book, join(root, 'nested/one/two/book')]);
});
test('writes replace a real temporary file and leave no temporary sibling', async (t) => {
	const { book } = await fixture(t);
	const file = join(book, chapter);
	await atomicWrite(file, '正文');
	assert.equal(await readFile(file, 'utf8'), '正文');
	const { readdir } = await import('node:fs/promises');
	const { dirname } = await import('node:path');
	assert.equal(
		(await readdir(dirname(file))).some((name) => name.endsWith('.tmp')),
		false,
	);
});
test('external edits notify, own writes do not, stale saves report a conflict', async (t) => {
	const { book, index } = await fixture(t);
	const changes: string[] = [];
	index.onFileChanged((file) => {
		changes.push(file.text);
	});
	index.start();
	const original = (await index.read(chapter)).text;
	assert.deepEqual(await index.save(chapter, original + '自己写的。', original), { saved: true });
	await sleep(180);
	assert.equal(changes.length, 0);
	const notified = new Promise<void>((resolve) => {
		index.onFileChanged(() => {
			resolve();
		});
	});
	await writeFile(join(book, chapter), '外部写的。');
	await notified;
	assert.deepEqual(changes, ['外部写的。']);
	assert.deepEqual(await index.save(chapter, '不应覆盖', original), { saved: false, disk: '外部写的。' });
	assert.equal(await readFile(join(book, chapter), 'utf8'), '外部写的。');
});
test('completion includes outlines and summaries, reuses requests, and honors daily limits and missing keys', async (t) => {
	const { root, index } = await fixture(t);
	const server = await fakeServer((res) =>
		stream(res, [
			openaiText('门后传来熟悉的脚步声，灯光照亮了台阶。'),
			openaiUsage({ prompt_tokens: 40, completion_tokens: 10 }),
			OPENAI_END,
		]),
	);
	t.after(() => server.close());
	const settings = new SettingsStore(join(root, 'data'));
	settings.set('provider', 'openaiCompatible');
	settings.set('openaiCompatible.baseUrl', server.baseUrl);
	settings.set('openaiCompatible.model', 'test');
	const usage = new UsageStore(join(root, 'usage'));
	await usage.load();
	const service = new CompletionService(settings, usage, () => undefined);
	const text = (await index.read(chapter)).text;
	const input = { id: 1, path: chapter, text, offset: text.length, manual: false };
	const result = await service.request('one', index, input);
	assert.equal(result.status, 'ok');
	const request = JSON.stringify(server.received[0].body);
	for (const label of ['全书', '第一卷 雾港', '第一幕 来信', '第2章 灯塔', '第1章 雾里来信']) {
		assert.ok(request.includes(label), label);
	}
	assert.ok(request.includes('林小满'));
	assert.ok(request.includes('周伯'));
	assert.deepEqual(await service.request('one', index, { ...input, id: 2 }), result);
	assert.equal(server.received.length, 1);
	await usage.add('test', { input: 1, output: 1 }, 2);
	settings.set('usage.dailyLimitUsd', 1);
	assert.equal((await service.request('one', index, { ...input, id: 3 })).status, 'skipped');
	assert.equal(service.status().state, 'limit');
	assert.equal((await service.request('one', index, { ...input, id: 4, manual: true })).status, 'ok');
	assert.equal(server.received.length, 2);
	settings.set('usage.dailyLimitUsd', 0);
	settings.set('provider', 'anthropic');
	assert.equal((await service.request('one', index, { ...input, id: 5 })).status, 'error');
	assert.equal(service.status().missingKey, true);
	assert.equal(server.received.length, 2);
	await service.drain();
});
test('cancelled requests still record usage and close before shutdown', async (t) => {
	const { root, index } = await fixture(t);
	let started!: () => void;
	const sawRequest = new Promise<void>((resolve) => {
		started = resolve;
	});
	const server = await fakeServer(async (res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write(openaiText('门'));
		started();
		await new Promise<void>((resolve) => res.on('close', resolve));
	});
	const settings = new SettingsStore(join(root, 'data'));
	settings.set('provider', 'openaiCompatible');
	settings.set('openaiCompatible.baseUrl', server.baseUrl);
	settings.set('openaiCompatible.model', 'test');
	const usage = new UsageStore(join(root, 'usage'));
	await usage.load();
	const service = new CompletionService(settings, usage, () => undefined);
	const text = (await index.read(chapter)).text;
	const response = service.request('cancel', index, { id: 1, path: chapter, text, offset: text.length, manual: false });
	await sawRequest;
	service.cancel('cancel', 1);
	assert.equal((await response).status, 'cancelled');
	await service.drain();
	assert.equal(usage.today().requests, 1);
	assert.equal(usage.today().unknown, 1);
	assert.equal(await server.received[0].closed, true);
	await server.close();
});
test('IPC book paths reject traversal before any file is read or written', async (t) => {
	const { book, index } = await fixture(t);

	const outside = join(book, '..', 'outside.txt');
	await writeFile(outside, '外面的文件');
	assert.throws(() => bookPath('../outside.txt'), /不能超出/);
	assert.throws(() => bookPath('正文/../../outside.txt'), /不能超出/);
	assert.throws(() => bookPath('/tmp/outside.txt'), /不能超出/);
	assert.equal((await index.read(bookPath(chapter))).path, chapter);
	assert.equal(await readFile(outside, 'utf8'), '外面的文件');
});
test('unreadable chapter paths remain indexed while opening and saving reject their bytes', async (t) => {
	const { book, index } = await fixture(t);
	const bad = '正文/bad.txt';
	const mixed = '正文/mixed.txt';
	const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
	await writeFile(join(book, bad), bytes);
	await writeFile(join(book, '设定/bad.txt'), bytes);
	await writeFile(join(book, '大纲/bad.txt'), bytes);
	await writeFile(join(book, '摘要/bad.txt'), bytes);
	await writeFile(join(book, mixed), '一\r\n二\n');
	await assert.rejects(index.read(bad), /不是 UTF-8/);
	await assert.rejects(index.save(bad, '不能写', '', true), /不是 UTF-8/);
	await assert.rejects(index.read(mixed), /混用了两种换行符/);
	await assert.rejects(index.save(mixed, '不能写', '', true), /混用了两种换行符/);
	const scanned = new BookIndex(book);
	await scanned.load();
	assert.equal(scanned.library.isChapter(bad), true);
	assert.equal(scanned.library.isChapter(mixed), true);
	assert.equal(scanned.library.isChapter(chapter), true);
	assert.equal(scanned.library.entry('设定/bad.txt'), undefined);
	assert.equal(scanned.library.companionOf('outline', bad), '大纲/bad.txt');
	assert.equal(scanned.library.companionOf('summary', bad), '摘要/bad.txt');
	assert.deepEqual(await readFile(join(book, bad)), bytes);
	assert.equal(await readFile(join(book, mixed), 'utf8'), '一\r\n二\n');
	scanned.dispose();
});
test('editing CRLF and LF files preserves their original newline convention', async (t) => {
	const { book, index } = await fixture(t);
	for (const ending of ['\r\n', '\n', '\r']) {
		await writeFile(join(book, chapter), ['第一段', '第二段', ''].join(ending));
		const file = await index.read(chapter);
		assert.equal(file.text, '第一段\n第二段\n');
		await index.save(chapter, file.text + '第三段\n', file.text);
		assert.equal(await readFile(join(book, chapter), 'utf8'), ['第一段', '第二段', '第三段', ''].join(ending));
	}
});
test('deleting and restoring an opened file emits both changes and restores the chapter index', async (t) => {
	const { book, index } = await fixture(t);
	const original = (await index.read(chapter)).text;
	index.start();
	const removed = new Promise<void>((resolve) => {
		index.onFileChanged((file) => {
			if (file.path === chapter && file.text === '') {
				resolve();
			}
		});
	});
	await rm(join(book, chapter));
	await removed;
	assert.equal(index.library.isChapter(chapter), false);
	const restored = new Promise<void>((resolve) => {
		index.onFileChanged((file) => {
			if (file.path === chapter && file.text === original) {
				resolve();
			}
		});
	});
	await writeFile(join(book, chapter), original);
	await restored;
	assert.equal(index.library.isChapter(chapter), true);
});
test('saving a chapter and its watcher event never reread the other chapters', async (t) => {
	const { book, index } = await fixture(t);
	const original = (await index.read(chapter)).text;

	// The watcher also reports the copy that made this fixture; let those events pass first.
	index.start();
	await sleep(300);
	const read = fs.readFile;
	const readPaths: string[] = [];
	const spy = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
		readPaths.push(String(args[0]));
		return read(...args);
	});
	await index.save(chapter, original + '自己写的。', original);
	await sleep(250);
	spy.mock.restore();
	assert.ok(readPaths.length > 0);
	assert.ok(
		readPaths.every((path) => path === join(book, chapter)),
		readPaths.join('\n'),
	);
});
test('missing remembered books are removed and restoration reports that a welcome window is needed', async (t) => {
	const { root } = await fixture(t);

	const store = new WindowStore(root);
	const missing = join(root, 'missing');
	store.opened(missing);
	const opened = await restoreBooks(store, async (path) => {
		const result = await inspectRememberedBook(path, store);
		assert.ok('error' in result);
		return { kind: 'error', message: '不存在' };
	});
	assert.equal(opened, 0);
	assert.deepEqual(store.value.open, []);
	assert.deepEqual(store.value.recent, []);
	assert.deepEqual(new WindowStore(root).value.recent, []);
});
test('story discovery does not read unrelated documents and skips inaccessible descendants', async (t) => {
	const { root, book } = await fixture(t);

	await mkdir(join(root, 'unrelated'), { recursive: true });
	await writeFile(join(root, 'unrelated', 'bad.txt'), Buffer.from([255, 255]));
	const denied = join(root, 'denied');
	await mkdir(denied);
	await fs.chmod(denied, 0);
	const read = fs.readFile;
	const paths: string[] = [];
	const spy = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
		paths.push(String(args[0]));
		return read(...args);
	});
	try {
		const result = await inspectBook(root);
		assert.equal(result.index, undefined);
		assert.equal(
			paths.some((path) => path.endsWith('bad.txt')),
			false,
		);
		assert.equal(
			paths.some((path) => path.startsWith(book + '/') && !path.endsWith('project.json')),
			false,
		);
	} finally {
		spy.mock.restore();
		await fs.chmod(denied, 0o700);
	}
});
test('a dead renderer never blocks window close waiting for a save acknowledgement', async () => {
	const gate = new CloseGate();
	assert.equal(gate.needsFlush(), true);
	gate.rendererGone();
	assert.equal(gate.needsFlush(), false);
	const saved = new CloseGate();
	saved.acknowledge();
	assert.equal(saved.needsFlush(), false);
});
/** Exercise the watcher callback without asking the OS for a filesystem watcher. */
function simulatedWatcher(t: TestContext, index: BookIndex) {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let callback!: (event: string, path: string) => void;
	t.mock.method(nativeFs, 'watch', (...args: Parameters<typeof nativeFs.watch>) => {
		callback = args[args.length - 1] as typeof callback;
		return { close() {} } as nativeFs.FSWatcher;
	});
	index.start();
	return async (paths: string[]) => {
		const changed = new Promise<void>((resolve) => {
			const off = index.onChanged(() => {
				off();
				resolve();
			});
		});
		for (const path of paths) {
			callback('change', path);
		}
		t.mock.timers.tick(60);
		await changed;
	};
}
test('unchanged writes to opened auxiliary files do not notify', async (t) => {
	const { book, index } = await fixture(t);
	const path = 'notes.md';
	await writeFile(join(book, path), '笔记');
	assert.equal((await index.read(path)).text, '笔记');
	const emit = simulatedWatcher(t, index);
	const changed: string[] = [];
	index.onFileChanged((file) => changed.push(file.text));
	await atomicWrite(join(book, path), '笔记');
	await emit([path]);
	assert.equal(changed.length, 0);
	await atomicWrite(join(book, path), '新笔记');
	await emit([path]);
	assert.deepEqual(changed, ['新笔记']);
});
test('watcher events and startup scans ignore hidden and non-prose files', async (t) => {
	const { book, index } = await fixture(t);
	const ignored = ['正文/.DS_Store', '正文/copy.bak', '正文/.hidden.md', '正文/.hidden/chapter.md'];
	await mkdir(join(book, '正文/.hidden'), { recursive: true });
	for (const path of ignored) {
		await writeFile(join(book, path), Buffer.from([255]));
	}
	const read = fs.readFile;
	const paths: string[] = [];
	t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
		paths.push(String(args[0]));
		return read(...args);
	});
	const scanned = new BookIndex(book);
	await scanned.load();
	scanned.dispose();
	const emit = simulatedWatcher(t, index);
	await emit([...ignored, chapter]);
	assert.equal(
		paths.some((path) => ignored.some((file) => path.endsWith(file))),
		false,
	);
	assert.equal(index.library.isChapter('正文/.hidden.md'), false);
});
test('book and file notifications support independent listeners and unsubscribe', async (t) => {
	const { book, index } = await fixture(t);
	const emit = simulatedWatcher(t, index);
	let bookA = 0,
		bookB = 0,
		fileA = 0,
		fileB = 0;
	const offBook = index.onChanged(() => {
		bookA++;
	});
	index.onChanged(() => {
		bookB++;
	});
	const offFile = index.onFileChanged(() => {
		fileA++;
	});
	index.onFileChanged(() => {
		fileB++;
	});
	await writeFile(join(book, chapter), '第一版');
	await emit([chapter]);
	offBook();
	offFile();
	await writeFile(join(book, chapter), '第二版');
	await emit([chapter]);
	assert.deepEqual([bookA, bookB, fileA, fileB], [1, 2, 1, 2]);
});
