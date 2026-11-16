import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { suggestChapterName } from '../core/book';
import { conflictCandidate, conflictOriginal, findConflictCopies, isUnderICloudRoot } from '../core/conflict';
import { MAX_FILE_BYTES } from '../core/snapshot';
import { BookSnapshots } from '../main/assistant/snapshots';
import { readConflictDiff, resolveConflictCopy } from '../main/book/conflicts';
import { isBookInICloud, parseTestICloudArg, readAuxiliaryOptional } from '../main/book/files';
import { BookIndex } from '../main/book/indexer';
import { Buoys } from '../main/buoys/service';
import { renameBook, renamePlan } from '../main/scaffold/rename';
import { SettingsStore } from '../main/settings/store';
import { defaults } from '../shared/defaults';
import { UsageStore } from '../storage/usageStore';

describe('conflict copy detection', () => {
	test('matches stem + space + integer >= 2 + .md only when enabled and the original .md exists in the same folder', () => {
		const files = new Set([
			'正文/第2章 灯塔.md',
			'正文/第2章 灯塔 2.md',
			'正文/第2章 灯塔 10.md',
			'正文/第2章 灯塔 3.md',
			'正文/第2章 灯塔 1.md',
			'正文/第2章 灯塔 0.md',
			'正文/第2章 灯塔 02.md',
			'正文/第2章 灯塔2.md',
			'正文/第2章 灯塔  2.md',
			'正文/孤本 2.md',
			'正文/只有txt.txt',
			'正文/只有txt 2.md',
			'正文/文本.txt',
			'正文/文本 2.txt',
			'其他/第2章 灯塔 4.md',
		]);

		assert.equal(conflictCandidate('正文/第2章 灯塔 2.md', true), '正文/第2章 灯塔.md');
		assert.equal(conflictCandidate('正文/第2章 灯塔 2.md', false), undefined);
		assert.equal(conflictCandidate('正文/第2章 灯塔 1.md', true), undefined);
		assert.equal(conflictCandidate('正文/第2章 灯塔 0.md', true), undefined);
		assert.equal(conflictCandidate('正文/第2章 灯塔 02.md', true), undefined);
		assert.equal(conflictCandidate('正文/文本 2.txt', true), undefined);
		assert.equal(conflictCandidate('.hidden 2.md', true), undefined);

		assert.equal(conflictOriginal('正文/第2章 灯塔 2.md', files, true), '正文/第2章 灯塔.md');
		assert.equal(conflictOriginal('正文/第2章 灯塔 2.md', files, false), undefined);
		assert.equal(conflictOriginal('正文/孤本 2.md', files, true), undefined);
		assert.equal(conflictOriginal('正文/只有txt 2.md', files, true), undefined);
		assert.equal(conflictOriginal('其他/第2章 灯塔 4.md', files, true), undefined);

		assert.deepEqual(findConflictCopies(files, true), [
			{ path: '正文/第2章 灯塔 2.md', original: '正文/第2章 灯塔.md' },
			{ path: '正文/第2章 灯塔 3.md', original: '正文/第2章 灯塔.md' },
			{ path: '正文/第2章 灯塔 10.md', original: '正文/第2章 灯塔.md' },
		]);
		assert.deepEqual(findConflictCopies(files, false), []);
	});

	test('resolves chained copies, checks iCloud root boundaries, and gates --icloud-dir on --test-mode', async (t) => {
		assert.deepEqual(findConflictCopies(['设定/雾港.md', '设定/雾港 2.md', '设定/雾港 2 2.md'], true), [
			{ path: '设定/雾港 2.md', original: '设定/雾港.md' },
			{ path: '设定/雾港 2 2.md', original: '设定/雾港.md' },
		]);
		assert.deepEqual(findConflictCopies(['设定/雾港.md', '设定/雾港 2.md', '设定/雾港 2 2.md'], false), []);

		assert.deepEqual(
			findConflictCopies(
				[
					'.novel-helper/project.json',
					'.novel-helper/project 2.json',
					'.novel-helper/buoys/正文/第2章 灯塔.md.json',
					'.novel-helper/buoys/正文/第2章 灯塔.md 3.json',
				],
				true,
				['.json'],
			),
			[
				{ path: '.novel-helper/buoys/正文/第2章 灯塔.md 3.json', original: '.novel-helper/buoys/正文/第2章 灯塔.md.json' },
				{ path: '.novel-helper/project 2.json', original: '.novel-helper/project.json' },
			],
		);

		assert.equal(
			isUnderICloudRoot('/Users/writer/Library/Mobile Documents/com~apple~CloudDocs/Book', '/Users/writer/Library/Mobile Documents'),
			true,
		);
		assert.equal(isUnderICloudRoot('/Users/writer/Library/Mobile Documents', '/Users/writer/Library/Mobile Documents'), false);
		assert.equal(
			isUnderICloudRoot('/Users/writer/Library/Mobile Documents Backup/Book', '/Users/writer/Library/Mobile Documents'),
			false,
		);
		assert.equal(isUnderICloudRoot('/Users/writer/Documents/Book', '/Users/writer/Library/Mobile Documents'), false);

		assert.equal(parseTestICloudArg(['electron', '--icloud-dir=/tmp/icloud']), undefined);
		assert.equal(parseTestICloudArg(['electron', '--test-mode', '--icloud-dir=/tmp/icloud']), '/tmp/icloud');

		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-boundary-'));
		t.after(() => rm(root, { recursive: true, force: true }));
		const icloud = join(root, 'icloud');
		const inside = join(icloud, 'book');
		const outside = join(root, 'local');
		await mkdir(inside, { recursive: true });
		await mkdir(outside, { recursive: true });
		assert.equal(isBookInICloud(inside, icloud), true);
		assert.equal(isBookInICloud(outside, icloud), false);
	});

	test('detects conflict copies only for books inside iCloud and treats identical names as normal files outside iCloud', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-conflict-test-'));
		const icloud = join(root, 'icloud');
		const book = join(icloud, 'book');
		const localBook = join(root, 'local-book');
		await cp(resolve('examples'), book, { recursive: true });
		await cp(resolve('examples'), localBook, { recursive: true });
		t.after(() => rm(root, { recursive: true, force: true }));

		const chapterOriginal = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
		const chapterCopy = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔 2.md';
		const outlineOriginal = '大纲/第一卷 雾港.md';
		const outlineCopy = '大纲/第一卷 雾港 2.md';
		const loreOriginal = '人物/林小满.md';
		const loreCopy = '人物/林小满 2.md';
		const orphanTwo = '正文/第一卷 雾港/第一幕 来信/第3章 远航 2.md';

		for (const target of [book, localBook]) {
			await writeFile(join(target, chapterCopy), '冲突章节正文');
			await writeFile(join(target, outlineCopy), '# 冲突卷纲\n\n## 多出来的节点\n');
			await writeFile(join(target, loreCopy), '---\naliases: [冲突独有称呼]\nalways: true\n---\n冲突人物卡片。');
			await writeFile(join(target, orphanTwo), '没有原文件的第3章 远航 2');
		}

		// Local book outside iCloud: all `... 2.md` files are indexed as ordinary files.
		const localIndex = new BookIndex(localBook, defaults, icloud);
		t.after(() => localIndex.dispose());
		await localIndex.load();
		assert.equal(localIndex.inICloud, false);
		assert.deepEqual(localIndex.book.conflicts, []);
		assert.equal(localIndex.library.isChapter(chapterCopy), true);
		assert.notEqual(localIndex.library.entry(loreCopy), undefined);
		assert.equal(localIndex.library.matcher().find('冲突独有称呼来了').length, 1);

		// Book inside iCloud: conflict copies are separated from the library.
		const index = new BookIndex(book, defaults, icloud);
		t.after(() => index.dispose());
		await index.load();
		assert.equal(index.inICloud, true);
		assert.deepEqual(index.book.conflicts, [
			{ path: chapterCopy, original: chapterOriginal },
			{ path: outlineCopy, original: outlineOriginal },
			{ path: loreCopy, original: loreOriginal },
		]);
		assert.equal(index.library.isChapter(chapterCopy), false);
		assert.equal(index.library.isChapter(orphanTwo), true);
		assert.equal(index.library.entry(loreCopy), undefined);
		assert.deepEqual(index.library.matcher().find('冲突独有称呼来了'), []);

		const graph = await index.outline();
		assert.equal([...graph.nodes.values()].some((node) => node.title === '多出来的节点'), false);

		await rm(join(book, orphanTwo));
		await index.refresh(orphanTwo);
		assert.equal(suggestChapterName(index.book.tree, index.book.tree, '第1章 '), '第3章 ');

		await rm(join(book, chapterOriginal));
		await index.refresh(chapterOriginal);
		assert.equal(index.library.isChapter(chapterCopy), true);
		assert.equal(index.book.conflicts.some((item) => item.path === chapterCopy), false);
	});

	test('ignores .json conflict copies of project.json and buoy files for books in iCloud', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-aux-conflict-test-'));
		const icloud = join(root, 'icloud');
		const book = join(icloud, 'book');
		await cp(resolve('examples'), book, { recursive: true });
		t.after(() => rm(root, { recursive: true, force: true }));

		const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
		const buoyConflict = '.novel-helper/buoys/正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md 2.json';
		const markerConflict = '.novel-helper/project 2.json';
		await writeFile(join(book, markerConflict), '{not-valid-json');
		await writeFile(join(book, buoyConflict), '{not-valid-json');

		assert.equal(await readAuxiliaryOptional(book, markerConflict, true), undefined);
		assert.equal(await readAuxiliaryOptional(book, buoyConflict, true), undefined);

		const index = new BookIndex(book, defaults, icloud);
		t.after(() => index.dispose());
		await index.load();
		assert.equal(index.marker?.version, 1);
		assert.deepEqual(index.book.conflicts, []);

		const settings = new SettingsStore(join(root, 'data'));
		const usage = new UsageStore(join(root, 'usage'));
		await usage.load();
		const buoys = new Buoys(index, settings, usage, () => undefined);
		t.after(() => buoys.dispose());
		const status = await buoys.status(chapter);
		assert.equal(status.lost, false);
		assert.equal(status.state?.nodes[0]?.title, '周伯收信');
		assert.equal(await buoys.status('正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md 2').then((s) => s.state), undefined);

		const plan = await renamePlan(index, chapter, '第2章 北角灯塔');
		const renamed = await index.exclusive(() => renameBook(index, plan));
		assert.equal(renamed.error, undefined);
		assert.equal(await readFile(join(book, buoyConflict), 'utf8'), '{not-valid-json');
	});

	test('validates hashes before/after snapshot and refuses replacing an original omitted from snapshots (> 5 MB)', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-conflict-resolve-test-'));
		const icloud = join(root, 'icloud');
		const book = join(icloud, 'book');
		const userData = join(root, 'user-data');
		const trash = join(root, 'trash');
		await cp(resolve('examples'), book, { recursive: true });
		await mkdir(userData, { recursive: true });
		await mkdir(trash, { recursive: true });
		t.after(() => rm(root, { recursive: true, force: true }));

		const chapterOriginal = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
		const chapterCopy = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔 2.md';
		const largeOriginal = '设定/巨型设定.md';
		const largeCopy = '设定/巨型设定 2.md';

		// Use CRLF on the original to verify raw-byte SHA-256 matches SnapshotStore's manifest hash.
		await writeFile(join(book, chapterOriginal), '第一段\r\n第二段\r\n');
		await writeFile(join(book, chapterCopy), '副本第一段\n副本第二段\n');
		const oversized = Buffer.alloc(MAX_FILE_BYTES + 128, 'a');
		await writeFile(join(book, largeOriginal), oversized);
		await writeFile(join(book, largeCopy), '精简后的设定副本\n');

		const index = new BookIndex(book, defaults, icloud);
		t.after(() => index.dispose());
		await index.load();
		const snapshots = new BookSnapshots(
			userData,
			() => ({ ...defaults, 'snapshots.intervalMinutes': 0 }),
			() => false,
			() => {},
		);
		const trashed: string[] = [];
		const trashItem = async (fullPath: string) => {
			trashed.push(basename(fullPath));
			await rename(fullPath, join(trash, `${trashed.length}-${basename(fullPath)}`));
		};

		// 1. Pre-snapshot hash mismatch on replace (`beforeHash` stale) and on trash (`afterHash` stale).
		const staleDiff = await readConflictDiff(index, chapterCopy);
		await writeFile(join(book, chapterOriginal), '第一段\r\niCloud 刚同步来的新段落\r\n');
		const preMismatch = await resolveConflictCopy(
			index,
			snapshots,
			{
				path: chapterCopy,
				action: 'replace',
				beforeHash: staleDiff.beforeHash,
				afterHash: staleDiff.afterHash,
			},
			trashItem,
		);
		assert.deepEqual(preMismatch, { ok: false, reason: 'changed', message: '文件刚被改过' });
		assert.equal(existsSync(join(book, chapterCopy)), true);
		assert.deepEqual(await snapshots.store(book).list(), []);

		await writeFile(join(book, chapterCopy), '副本又在另一台机器改了一次\n');
		const trashMismatch = await resolveConflictCopy(
			index,
			snapshots,
			{ path: chapterCopy, action: 'trash', afterHash: staleDiff.afterHash },
			trashItem,
		);
		assert.deepEqual(trashMismatch, { ok: false, reason: 'changed', message: '文件刚被改过' });
		assert.equal(existsSync(join(book, chapterCopy)), true);
		assert.deepEqual(trashed, []);

		// 2. Mid-snapshot external edit on original right as `store.begin` finishes scanning.
		const midDiff = await readConflictDiff(index, chapterCopy);
		const store = snapshots.store(book);
		const realBegin = store.begin.bind(store);
		let injectedOnce = false;
		store.begin = async (about) => {
			const record = await realBegin(about);
			if (!injectedOnce) {
				injectedOnce = true;
				await writeFile(join(book, chapterOriginal), '扫描快照期间 iCloud 改写了原文\r\n');
			}
			return record;
		};
		const midMismatch = await resolveConflictCopy(
			index,
			snapshots,
			{
				path: chapterCopy,
				action: 'replace',
				beforeHash: midDiff.beforeHash,
				afterHash: midDiff.afterHash,
			},
			trashItem,
		);
		store.begin = realBegin;
		assert.deepEqual(midMismatch, { ok: false, reason: 'changed', message: '文件刚被改过' });
		assert.equal(await readFile(join(book, chapterOriginal), 'utf8'), '扫描快照期间 iCloud 改写了原文\r\n');
		assert.equal(existsSync(join(book, chapterCopy)), true);
		assert.deepEqual(await store.list(), []);

		// 3. Original > 5 MB skipped by snapshot: refuses replacement and leaves both files untouched.
		const largeDiff = await readConflictDiff(index, largeCopy);
		const unbacked = await resolveConflictCopy(
			index,
			snapshots,
			{
				path: largeCopy,
				action: 'replace',
				beforeHash: largeDiff.beforeHash,
				afterHash: largeDiff.afterHash,
			},
			trashItem,
		);
		assert.deepEqual(unbacked, { ok: false, reason: 'unbacked', message: '原文太大或无法存快照，不替换' });
		assert.equal((await readFile(join(book, largeOriginal))).byteLength, MAX_FILE_BYTES + 128);
		assert.equal(existsSync(join(book, largeCopy)), true);
		assert.deepEqual(await store.list(), []);

		// 4. Fresh diff with matching hashes succeeds, stores original in snapshot, and reverts cleanly.
		const freshDiff = await readConflictDiff(index, chapterCopy);
		const ok = await resolveConflictCopy(
			index,
			snapshots,
			{
				path: chapterCopy,
				action: 'replace',
				beforeHash: freshDiff.beforeHash,
				afterHash: freshDiff.afterHash,
			},
			trashItem,
		);
		assert.deepEqual(ok, { ok: true });
		assert.equal(await readFile(join(book, chapterOriginal), 'utf8'), '副本又在另一台机器改了一次\n');
		assert.equal(existsSync(join(book, chapterCopy)), false);
		assert.deepEqual(trashed, ['第2章 灯塔 2.md']);

		const records = await store.list();
		assert.equal(records.length, 1);
		assert.equal(records[0].files[chapterOriginal], freshDiff.beforeHash);
		await store.revert(records[0].id);
		assert.equal(await readFile(join(book, chapterOriginal), 'utf8'), '扫描快照期间 iCloud 改写了原文\r\n');
	});
});
