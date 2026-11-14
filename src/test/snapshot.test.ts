// Snapshots of a story folder: what is kept, what a turn is found to have
// changed, going back, and what is thrown away.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsp = require('node:fs/promises');
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, mock, test } from 'node:test';
import {
	afterManifest,
	changeKind,
	diff,
	expired,
	looksBinary,
	MAX_FILE_BYTES,
	parseRecord,
	referenced,
	restorePlan,
	skipsFolder,
	SNAPSHOT_DIR,
	type SnapshotRecord,
	titleOf,
} from '../core/snapshot';
import { BookSnapshots } from '../main/assistant/snapshots';
import { BookIndex } from '../main/book/indexer';
import { renameBook, renamePlan } from '../main/scaffold/rename';
import { defaults, type Settings } from '../shared/defaults';
import { SnapshotStore } from '../storage/snapshotStore';
import { filesIn } from './files';

const made: string[] = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A story folder with these files, and its store. */
function story(files: Record<string, string | Buffer>, keep = 50, timedKeep = 100) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-snapshot-'));
	made.push(dir);
	const write = (file: string, content: string | Buffer = '') => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), content);
	};
	Object.entries(files).forEach(([file, content]) => write(file, content));
	return {
		dir,
		store: new SnapshotStore(
			dir,
			() => keep,
			() => timedKeep,
		),
		write,
		remove: (file: string) => fs.rmSync(path.join(dir, file)),
		read: (file: string) => fs.readFileSync(path.join(dir, file), 'utf8'),
		/** The story's own files, the snapshots aside. */
		files: () => filesIn(dir).filter((file) => !file.startsWith(`${SNAPSHOT_DIR}/`)),
		objects: () => filesIn(path.join(dir, SNAPSHOT_DIR, 'objects')).length,
		timedObjects: () => filesIn(path.join(dir, SNAPSHOT_DIR, 'timed-objects')).length,
	};
}

/** A temporary copy of `examples` for testing `BookSnapshots`. */
function exampleCopy() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-examples-'));
	made.push(dir);
	fs.cpSync(path.resolve('examples'), dir, { recursive: true });
	return dir;
}

describe('what a snapshot holds', () => {
	test('folders that are left out, at any depth', () => {
		assert.equal(skipsFolder('.git'), true);
		assert.equal(skipsFolder('资料/node_modules'), true);
		assert.equal(skipsFolder(SNAPSHOT_DIR), true);
		assert.equal(skipsFolder('.novel-helper'), false);
		assert.equal(skipsFolder('.novel-helper/templates'), false);
		assert.equal(skipsFolder('正文/snapshots'), false);
	});

	test('binary is told by a NUL byte near the start', () => {
		assert.equal(looksBinary(Buffer.from('雾港的早晨。\n')), false);
		assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
		assert.equal(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])), false);
	});

	test('text files only, not the snapshots, .git, node_modules, big or binary files; each content once', async () => {
		const one = story({
			'正文/第一卷/第1章.md': '雾',
			'正文/第一卷/第2章.md': '雾',
			'设定/雾港.md': '港',
			'.novel-helper/project.json': '{"version":1}',
			'.git/HEAD': 'ref',
			'资料/node_modules/x/index.js': '1',
			'资料/地图.png': Buffer.from([1, 0, 2]),
			'资料/全文.txt': Buffer.alloc(MAX_FILE_BYTES + 1, 0x61),
		});
		const manifest = await one.store.capture();
		assert.deepEqual(Object.keys(manifest).sort(), ['.novel-helper/project.json', '正文/第一卷/第1章.md', '正文/第一卷/第2章.md', '设定/雾港.md']);
		assert.equal(manifest['正文/第一卷/第1章.md'], manifest['正文/第一卷/第2章.md']);
		assert.equal(one.objects(), 3);
		assert.equal((await one.store.read(manifest['设定/雾港.md'])).toString(), '港');
		// Taking it again adds nothing, and the snapshots are not part of the next one.
		assert.deepEqual(await one.store.capture(), manifest);
		assert.equal(one.objects(), 3);
		assert.equal(fs.readFileSync(path.join(one.dir, SNAPSHOT_DIR, '.gitignore'), 'utf8'), '*\n');
	});
});

describe('comparing snapshots', () => {
	test('added, removed and modified files, in reading order', () => {
		const changes = diff(
			{ '正文/第10章.md': 'a', '正文/第2章.md': 'b', '设定/旧.md': 'c', '大纲/全书.md': 'd' },
			{ '正文/第10章.md': 'a2', '正文/第2章.md': 'b2', '正文/第3章.md': 'e', '大纲/全书.md': 'd' },
		);
		assert.deepEqual(
			changes.map((change) => `${changeKind(change)} ${change.path}`),
			['modified 正文/第2章.md', 'added 正文/第3章.md', 'modified 正文/第10章.md', 'removed 设定/旧.md'],
		);
	});

	test('going back writes what changed or went away, and removes what was made since', () => {
		assert.deepEqual(restorePlan({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' }), {
			write: [
				{ path: 'b', hash: '2' },
				{ path: 'c', hash: '3' },
			],
			remove: ['d'],
		});
	});

	test('the oldest records over the limit expire; what the others refer to is still needed', () => {
		assert.deepEqual(expired([5, 1, 3, 2, 4], 2), [1, 2, 3]);
		assert.deepEqual(expired([1, 2], 5), []);
		assert.deepEqual(expired([1, 2], 0), [1]);
		const hashes = referenced([
			{
				id: 1,
				time: '',
				kind: 'turn',
				files: { a: 'h1' },
				changes: [
					{ path: 'a', before: 'h1', after: 'h2' },
					{ path: 'b', after: 'h3' },
				],
			},
		]);
		assert.deepEqual([...hashes].sort(), ['h1', 'h2', 'h3']);
	});

	test('a record whose paths lead out of the story folder is not one', () => {
		const record = { id: 1, time: '', kind: 'turn', files: { '正文/第1章.md': 'h' } };
		assert.deepEqual(parseRecord(JSON.stringify(record)), record);
		assert.equal(parseRecord(JSON.stringify({ ...record, files: { '../outside.md': 'h' } })), undefined);
		assert.equal(parseRecord(JSON.stringify({ ...record, files: { '/etc/passwd': 'h' } })), undefined);
		assert.equal(parseRecord(JSON.stringify({ ...record, changes: [{ path: '正文/../../x', after: 'h' }] })), undefined);
		assert.equal(parseRecord('not json'), undefined);
		assert.equal(parseRecord('{"id":1}'), undefined);
	});

	test('the title of a turn is the start of its message', () => {
		assert.equal(titleOf('  把选中这段改得紧凑些\n\n另外……'), '把选中这段改得紧凑些');
		assert.equal(titleOf('字'.repeat(70)), `${'字'.repeat(60)}…`);
	});
});

describe('turns', () => {
	test('what a turn changed is found on disk, whoever wrote it', async () => {
		const one = story({ '正文/第1章.md': '一', '正文/第2章.md': '二', '设定/雾港.md': '港' });
		const record = await one.store.begin({ kind: 'turn', title: '改第1章' });
		one.write('正文/第1章.md', '一改');
		one.write('摘要/第1章.md', '摘要');
		one.remove('设定/雾港.md');
		const changes = await one.store.finish(record.id);
		assert.deepEqual(
			changes.map((change) => `${changeKind(change)} ${change.path}`),
			['added 摘要/第1章.md', 'modified 正文/第1章.md', 'removed 设定/雾港.md'],
		);
		const [kept] = await one.store.list();
		assert.equal(kept.title, '改第1章');
		assert.deepEqual(kept.changes, changes);
		// Both sides of every change can be read back.
		assert.equal((await one.store.read(changes[1].before!)).toString(), '一');
		assert.equal((await one.store.read(changes[1].after!)).toString(), '一改');
	});

	test('a turn that changed nothing leaves no record', async () => {
		const one = story({ '正文/第1章.md': '一' });
		const record = await one.store.begin({ kind: 'turn', title: '这一章怎么样' });
		assert.deepEqual(await one.store.finish(record.id), []);
		assert.deepEqual(await one.store.list(), []);
	});

	test('going back restores changed and deleted files and deletes new ones; going back can be gone back from', async () => {
		const one = story({ '正文/第1章.md': '一', '正文/第2章.md': '二', '资料/地图.png': Buffer.from([1, 0, 2]) });
		const first = await one.store.begin({ kind: 'turn', title: '第一轮' });
		one.write('正文/第1章.md', '一改');
		await one.store.finish(first.id);
		const second = await one.store.begin({ kind: 'turn', title: '第二轮' });
		one.write('正文/第3章.md', '三');
		one.remove('正文/第2章.md');
		await one.store.finish(second.id);
		// Written by hand after the turns: it goes back as well, and comes back with the going back undone.
		one.write('正文/第1章.md', '一改，又手改');

		assert.deepEqual(await one.store.preview(first.id), {
			write: [
				{ path: '正文/第1章.md', hash: first.files['正文/第1章.md'] },
				{ path: '正文/第2章.md', hash: first.files['正文/第2章.md'] },
			],
			remove: ['正文/第3章.md'],
			blocked: [],
		});
		const { record: back, blocked } = await one.store.revert(first.id);
		assert.deepEqual(blocked, []);
		assert.deepEqual(one.files(), ['正文/第1章.md', '正文/第2章.md', '资料/地图.png']);
		assert.equal(one.read('正文/第1章.md'), '一');
		assert.equal(one.read('正文/第2章.md'), '二');
		assert.equal(back?.kind, 'revert');
		assert.equal(back?.target, first.id);
		assert.deepEqual(
			back?.changes?.map((change) => `${changeKind(change)} ${change.path}`),
			['modified 正文/第1章.md', 'added 正文/第2章.md', 'removed 正文/第3章.md'],
		);

		await one.store.revert(back!.id);
		assert.deepEqual(one.files(), ['正文/第1章.md', '正文/第3章.md', '资料/地图.png']);
		assert.equal(one.read('正文/第1章.md'), '一改，又手改');
		assert.deepEqual(
			(await one.store.list()).map((record) => record.kind),
			['turn', 'turn', 'revert', 'revert'],
		);
	});

	test('revert and undo-revert write manuscript files through a same-directory temporary file and rename', async () => {
		const one = story({ '正文/第1章.md': '初稿完整内容' });
		const turn = await one.store.begin({ kind: 'turn', title: '改写' });
		one.write('正文/第1章.md', '改后完整内容');
		await one.store.finish(turn.id);

		const chapterDir = path.join(one.dir, '正文');
		const writeFile = fsp.writeFile;
		let tempWritten = '';
		const failFirst = mock.method(fsp, 'writeFile', async (...args: Parameters<typeof fsp.writeFile>) => {
			const target = String(args[0]);
			if (target.startsWith(chapterDir)) {
				failFirst.mock.restore();
				tempWritten = target;
				await writeFile(target, '半截');
				throw new Error('ENOSPC');
			}
			return writeFile(...args);
		});
		await assert.rejects(one.store.revert(turn.id), /ENOSPC/);
		assert.equal(path.dirname(tempWritten), chapterDir);
		assert.ok(tempWritten.endsWith('.tmp'));
		assert.equal(one.read('正文/第1章.md'), '改后完整内容');
		fs.rmSync(tempWritten, { force: true });

		const { record: undo } = await one.store.revert(turn.id);
		assert.equal(one.read('正文/第1章.md'), '初稿完整内容');

		let undoTemp = '';
		const failUndo = mock.method(fsp, 'writeFile', async (...args: Parameters<typeof fsp.writeFile>) => {
			const target = String(args[0]);
			if (target.startsWith(chapterDir)) {
				failUndo.mock.restore();
				undoTemp = target;
				await writeFile(target, '半截');
				throw new Error('ENOSPC');
			}
			return writeFile(...args);
		});
		await assert.rejects(one.store.revert(undo!.id), /ENOSPC/);
		assert.equal(path.dirname(undoTemp), chapterDir);
		assert.ok(undoTemp.endsWith('.tmp'));
		assert.equal(one.read('正文/第1章.md'), '初稿完整内容');
		fs.rmSync(undoTemp, { force: true });

		await one.store.revert(undo!.id);
		assert.equal(one.read('正文/第1章.md'), '改后完整内容');
	});

	test('going back to where the folder already is changes nothing and leaves no record', async () => {
		const one = story({ '正文/第1章.md': '一' });
		const record = await one.store.begin({ kind: 'turn', title: '改' });
		one.write('正文/第1章.md', '一改');
		await one.store.finish(record.id);
		one.write('正文/第1章.md', '一');
		assert.deepEqual(await one.store.revert(record.id), { blocked: [] });
		assert.equal((await one.store.list()).length, 1);
		assert.deepEqual(await one.store.revert(99), { blocked: [] });
	});

	test('only the newest records are kept, and contents nothing refers to are removed', async () => {
		const one = story({ '正文/第1章.md': '0', '设定/雾港.md': '港' }, 2);
		for (const text of ['1', '2', '3', '4']) {
			const record = await one.store.begin({ kind: 'turn', title: text });
			one.write('正文/第1章.md', text);
			await one.store.finish(record.id);
		}
		const records = await one.store.list();
		assert.deepEqual(
			records.map((record) => record.title),
			['3', '4'],
		);
		// Left: 港, and the chapter as 2, 3 and 4. Its contents 0 and 1 are gone.
		assert.equal(one.objects(), 4);
		await one.store.revert(records[0].id);
		assert.equal(one.read('正文/第1章.md'), '2');
	});

	test('going back does not write over what no snapshot holds now: it says which files, and changes nothing', async () => {
		const chapters = ['正文/第1章.md', '正文/第2章.md', '正文/第3章.md', '正文/第4章.md', '正文/第5章.md'];
		const one = story({ ...Object.fromEntries(chapters.map((chapter) => [chapter, '原样'])), '摘要/第1章.md': '摘要' });
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-outside-'));
		made.push(outside);
		fs.writeFileSync(path.join(outside, 'kept.md'), '目录外的文件');
		const first = await one.store.begin({ kind: 'turn', title: '改' });
		// Since the turn began: one chapter changed like any other, and the others became things a snapshot leaves out.
		one.write('正文/第1章.md', '改了');
		one.write('正文/第2章.md', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
		one.write('正文/第3章.md', Buffer.from([0x50, 0x4b, 0, 1]));
		one.remove('正文/第4章.md');
		fs.symlinkSync(path.join(outside, 'kept.md'), path.join(one.dir, '正文/第4章.md'));
		one.remove('正文/第5章.md');
		one.write('正文/第5章.md/草稿.md', '成了文件夹');
		fs.rmSync(path.join(one.dir, '摘要'), { recursive: true });
		fs.symlinkSync(outside, path.join(one.dir, '摘要'));
		await one.store.finish(first.id);

		const inTheWay = [
			{ path: '摘要/第1章.md', why: 'link' },
			{ path: '正文/第2章.md', why: 'large' },
			{ path: '正文/第3章.md', why: 'binary' },
			{ path: '正文/第4章.md', why: 'link' },
			{ path: '正文/第5章.md', why: 'taken' },
		];
		assert.deepEqual((await one.store.preview(first.id))?.blocked, inTheWay);
		const before = (await one.store.list()).length;
		assert.deepEqual(await one.store.revert(first.id), { blocked: inTheWay });
		assert.equal(one.read('正文/第1章.md'), '改了', 'not even the file that could have been put back');
		assert.equal(fs.statSync(path.join(one.dir, '正文/第2章.md')).size, MAX_FILE_BYTES + 1);
		assert.deepEqual([...fs.readFileSync(path.join(one.dir, '正文/第3章.md'))], [0x50, 0x4b, 0, 1]);
		assert.ok(fs.lstatSync(path.join(one.dir, '正文/第4章.md')).isSymbolicLink());
		assert.equal(one.read('正文/第5章.md/草稿.md'), '成了文件夹');
		assert.deepEqual(fs.readdirSync(outside), ['kept.md']);
		assert.equal(fs.readFileSync(path.join(outside, 'kept.md'), 'utf8'), '目录外的文件');
		assert.equal((await one.store.list()).length, before, 'and no record of a going back that did not happen');

		// With those out of the way, going back goes through.
		for (const file of ['正文/第2章.md', '正文/第3章.md', '正文/第4章.md', '正文/第5章.md', '摘要']) {
			fs.rmSync(path.join(one.dir, file), { recursive: true });
		}
		assert.deepEqual((await one.store.revert(first.id)).blocked, []);
		assert.deepEqual(one.files(), ['摘要/第1章.md', ...chapters]);
		assert.deepEqual(one.files().map(one.read), ['摘要', '原样', '原样', '原样', '原样', '原样']);
		assert.deepEqual(fs.readdirSync(outside), ['kept.md']);
	});

	test('a window that dies while it writes a record leaves the record as it was, and what the record needs is kept', async () => {
		const one = story({ '正文/第1章.md': '一' });
		const record = await one.store.begin({ kind: 'turn', title: '改' });
		one.write('正文/第1章.md', '一改');
		// The end of the turn: the file the record is being written to is opened, emptied, and that is as far as it gets.
		const writeFile = fsp.writeFile;
		const cut = mock.method(fsp, 'writeFile', async (...args: Parameters<typeof fsp.writeFile>) => {
			if (String(args[0]).includes(`${path.sep}turns${path.sep}`)) {
				cut.mock.restore();
				await writeFile(args[0], '');
				throw new Error('killed');
			}
			return writeFile(...args);
		});
		await assert.rejects(one.store.finish(record.id), /killed/);

		// The window is opened again; another turn comes and goes, and clears away what nothing refers to.
		const again = new SnapshotStore(one.dir, () => 50);
		assert.deepEqual(
			(await again.list()).map((kept) => kept.id),
			[record.id],
		);
		const next = await again.begin({ kind: 'turn', title: '再改' });
		one.write('正文/第1章.md', '一再改');
		await again.finish(next.id);
		assert.deepEqual(filesIn(path.join(one.dir, SNAPSHOT_DIR, 'turns')), ['000001.json', '000002.json'], 'what was half-written is cleared away');
		await again.revert(record.id);
		assert.equal(one.read('正文/第1章.md'), '一');
	});

	test('two windows that start a turn at the same moment get a record each', async () => {
		const one = story({ '正文/第1章.md': '一' });
		const other = new SnapshotStore(one.dir, () => 50);
		const records = await Promise.all([one.store.begin({ kind: 'turn', title: '甲' }), other.begin({ kind: 'turn', title: '乙' })]);
		assert.deepEqual(
			records.map((record) => record.id).sort(),
			[1, 2],
		);
		assert.deepEqual(
			(await one.store.list()).map((record) => record.title).sort(),
			['乙', '甲'],
		);
	});

	test('what one window has kept for a record it is about to write is not cleared away by another that ends a turn', async () => {
		const one = story({ '正文/第1章.md': '一' });
		const other = new SnapshotStore(one.dir, () => 50);
		const first = await other.begin({ kind: 'turn', title: '乙' });
		one.write('正文/第1章.md', '二');
		// This window has read the folder and is held up right before it writes its record.
		let reached!: () => void;
		const there = new Promise<void>((resolve) => (reached = resolve));
		const turns = path.join(one.dir, SNAPSHOT_DIR, 'turns');
		const readdir = fsp.readdir as (...args: unknown[]) => Promise<unknown>;
		const hold = mock.method(fsp as unknown as { readdir: typeof readdir }, 'readdir', async (...args: unknown[]) => {
			if (args[0] === turns) {
				hold.mock.restore();
				reached();
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			return readdir(...args);
		});
		const beginning = one.store.begin({ kind: 'turn', title: '甲' });
		await there;
		// Meanwhile the other window's turn ends, with the file changed once more.
		one.write('正文/第1章.md', '三');
		await other.finish(first.id);
		const second = await beginning;
		assert.equal((await one.store.read(second.files['正文/第1章.md'])).toString(), '二');
		assert.deepEqual(
			(await one.store.list()).map((record) => record.id),
			[1, 2],
		);
	});

	test('a record left without its end (the window was closed during the turn) can still be gone back to', async () => {
		const one = story({ '正文/第1章.md': '一' });
		const record = await one.store.begin({ kind: 'turn', title: '改' });
		one.write('正文/第1章.md', '写到一半');
		assert.equal((await one.store.list())[0].changes, undefined);
		await one.store.revert(record.id);
		assert.equal(one.read('正文/第1章.md'), '一');
	});
});

describe('timed snapshots', () => {
	const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';

	test('saves only once the interval has elapsed since the latest snapshot of any kind, and skips unchanged saves', async () => {
		const root = exampleCopy();
		const full = path.join(root, ...chapter.split('/'));
		const original = fs.readFileSync(full, 'utf8');
		const current: Settings = { ...structuredClone(defaults), 'snapshots.intervalMinutes': 10 };
		const snapshots = new BookSnapshots(() => current);
		const t0 = Date.parse('2026-04-01T10:00:00.000Z');
		await snapshots.open(root, t0);

		// Unchanged save past the interval writes nothing and does not create `.novel-helper/snapshots`.
		assert.equal(await snapshots.afterSave(root, t0 + 15 * 60_000), undefined);
		assert.equal(fs.existsSync(path.join(root, SNAPSHOT_DIR)), false);

		// Changed save before the interval elapses does not snapshot yet.
		fs.writeFileSync(full, original + '\n第一处手写改动。\n');
		assert.equal(await snapshots.afterSave(root, t0 + 9 * 60_000), undefined);

		// Reaching the 10-minute mark creates a timed snapshot with both before and after contents readable.
		const first = await snapshots.afterSave(root, t0 + 10 * 60_000);
		assert.equal(first?.kind, 'timed');
		assert.deepEqual(
			first?.changes?.map((change) => `${changeKind(change)} ${change.path}`),
			[`modified ${chapter}`],
		);
		const store = snapshots.store(root);
		assert.equal((await store.read(first!.changes![0].before!)).toString('utf8'), original);
		assert.equal((await store.read(first!.changes![0].after!)).toString('utf8'), original + '\n第一处手写改动。\n');

		// Repeating afterSave after another 10 minutes with no further edits writes nothing.
		assert.equal(await snapshots.afterSave(root, t0 + 25 * 60_000), undefined);

		// An assistant turn updates the latest snapshot clock; a manual save 5 minutes after that turn waits for the full interval.
		const turnAt = Date.now();
		const turn = await store.begin({ kind: 'turn', title: '助手润色' });
		fs.writeFileSync(full, original + '\n助手改过的稿子。\n');
		await store.finish(turn.id);
		const turnTime = Date.parse((await store.get(turn.id))!.time);
		assert.ok(turnTime >= turnAt);

		fs.writeFileSync(full, original + '\n助手之后又手改。\n');
		assert.equal(await snapshots.afterSave(root, turnTime + 5 * 60_000), undefined);
		const second = await snapshots.afterSave(root, turnTime + 10 * 60_000);
		assert.equal(second?.kind, 'timed');
		assert.equal((await store.read(second!.changes![0].before!)).toString('utf8'), original + '\n助手改过的稿子。\n');
		assert.equal((await store.read(second!.changes![0].after!)).toString('utf8'), original + '\n助手之后又手改。\n');
		assert.deepEqual(
			(await store.list()).map((record) => record.kind),
			['timed', 'turn', 'timed'],
		);
	});

	test('closing a book snapshots unsnapshotted changes immediately, skips unchanged closes, and respects busy turns and interval 0', async () => {
		const root = exampleCopy();
		const full = path.join(root, ...chapter.split('/'));
		const original = fs.readFileSync(full, 'utf8');
		let busy = false;
		const current: Settings = { ...structuredClone(defaults), 'snapshots.intervalMinutes': 10 };
		const snapshots = new BookSnapshots(
			() => current,
			async () => busy,
		);
		const t0 = Date.parse('2026-04-01T12:00:00.000Z');
		await snapshots.open(root, t0);

		// Closing without changes writes nothing.
		assert.equal(await snapshots.close(root, t0 + 60_000), undefined);

		// Reopen, edit for 1 minute (< 10 min interval), and close -> saves a timed snapshot.
		await snapshots.open(root, t0 + 120_000);
		fs.writeFileSync(full, original + '\n关书前写的。\n');
		assert.equal(await snapshots.afterSave(root, t0 + 180_000), undefined);
		const onClose = await snapshots.close(root, t0 + 185_000);
		assert.equal(onClose?.kind, 'timed');

		// Closing again right after without edits writes nothing.
		await snapshots.open(root, t0 + 190_000);
		assert.equal(await snapshots.close(root, t0 + 200_000), undefined);

		// While an assistant turn is busy, neither afterSave nor close writes a timed snapshot, while the assistant turn snapshot still works.
		await snapshots.open(root, t0 + 210_000);
		busy = true;
		const store = snapshots.store(root);
		const turn = await store.begin({ kind: 'turn', title: '正在改稿' });
		fs.writeFileSync(full, original + '\n助手进行中。\n');
		assert.equal(await snapshots.afterSave(root, t0 + 25 * 60_000), undefined);
		assert.equal(await snapshots.close(root, t0 + 26 * 60_000), undefined);
		await store.finish(turn.id);
		busy = false;
		assert.deepEqual(
			(await store.list()).map((record) => record.kind),
			['timed', 'turn'],
		);

		// Setting `snapshots.intervalMinutes` to 0 disables timed snapshots on both save and close.
		current['snapshots.intervalMinutes'] = 0;
		const nextStart = Date.parse((await store.list()).at(-1)!.time) + 60_000;
		await snapshots.open(root, nextStart);
		fs.writeFileSync(full, original + '\n关掉定时快照后的改动。\n');
		assert.equal(await snapshots.afterSave(root, nextStart + 30 * 60_000), undefined);
		assert.equal(await snapshots.close(root, nextStart + 31 * 60_000), undefined);
		assert.equal((await store.list()).length, 2);
	});

	test('reopening and closing again while a previous close snapshot is still running finishes drain without deadlock', async () => {
		const root = exampleCopy();
		const full = path.join(root, ...chapter.split('/'));
		const original = fs.readFileSync(full, 'utf8');
		const current: Settings = { ...structuredClone(defaults), 'snapshots.intervalMinutes': 10 };
		const snapshots = new BookSnapshots(() => current);
		const t0 = Date.parse('2026-04-01T14:00:00.000Z');
		await snapshots.open(root, t0);
		fs.writeFileSync(full, original + '\n第一次关书前改动。\n');

		const store = snapshots.store(root);
		const realTimed = store.timed.bind(store);
		let started!: () => void;
		let release!: () => void;
		const reached = new Promise<void>((resolve) => (started = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const hold = mock.method(store, 'timed', async (...args: Parameters<typeof store.timed>) => {
			hold.mock.restore();
			started();
			await gate;
			return realTimed(...args);
		});

		const firstClose = snapshots.close(root, t0 + 60_000);
		await reached;
		const reopened = snapshots.open(root, t0 + 70_000);
		const secondClose = snapshots.close(root, t0 + 80_000);
		release();

		const [firstRecord, , secondRecord] = await Promise.all([firstClose, reopened, secondClose, snapshots.drain()]);
		assert.equal(firstRecord?.kind, 'timed');
		assert.equal(secondRecord, undefined);
	});

	test('write returns save and rename results without waiting for timed snapshots, tracks them in drain, and reports snapshot errors once', async () => {
		const root = exampleCopy();
		const index = new BookIndex(root);
		await index.load();
		try {
			const current: Settings = { ...structuredClone(defaults), 'snapshots.intervalMinutes': 10 };
			const notices: string[] = [];
			const snapshots = new BookSnapshots(
				() => current,
				async () => false,
				(_bookRoot, message) => notices.push(message),
			);
			const t0 = Date.parse('2026-04-01T15:00:00.000Z');
			await snapshots.open(root, t0);
			const store = snapshots.store(root);

			// Background snapshot still running: save returns immediately while `drain()` waits for the snapshot to finish.
			const realTimed = store.timed.bind(store);
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			let snapshotDone = false;
			const slow = mock.method(store, 'timed', async (...args: Parameters<typeof store.timed>) => {
				slow.mock.restore();
				await gate;
				const record = await realTimed(...args);
				snapshotDone = true;
				return record;
			});

			const initial = await index.read(chapter);
			const saved = await snapshots.write(
				root,
				() => index.save(chapter, initial.text + '后台快照保存。\n', initial.text),
				(result) => result.saved,
				t0 + 15 * 60_000,
			);
			assert.deepEqual(saved, { saved: true });
			assert.equal(snapshotDone, false);
			release();
			await snapshots.drain();
			assert.equal(snapshotDone, true);
			assert.equal((await store.list()).length, 1);

			// Timed snapshot throws on both save and rename: both operations still succeed and notice is emitted once.
			const broken = mock.method(store, 'timed', async () => {
				throw new Error('磁盘已满');
			});
			const afterFirst = await index.read(chapter);
			const savedAgain = await snapshots.write(
				root,
				() => index.save(chapter, afterFirst.text + '快照失败但保存成功。\n', afterFirst.text),
				(result) => result.saved,
				t0 + 30 * 60_000,
			);
			assert.deepEqual(savedAgain, { saved: true });
			await snapshots.drain();

			const plan = await renamePlan(index, chapter, '新灯塔');
			const renamed = await snapshots.write(
				root,
				() => index.exclusive(() => renameBook(index, plan)),
				() => true,
				t0 + 45 * 60_000,
			);
			assert.equal(renamed.renames.length > 0, true);
			await snapshots.drain();
			broken.mock.restore();

			assert.equal(notices.length, 1);
			assert.match(notices[0], /^定时快照没存上：.*磁盘已满/);
		} finally {
			index.dispose();
		}
	});

	test('saves while initial baseline is scanning wait for the baseline, and interval 0 skips baseline until enabled', async () => {
		const root = exampleCopy();
		const index = new BookIndex(root);
		await index.load();
		try {
			const current: Settings = { ...structuredClone(defaults), 'snapshots.intervalMinutes': 10 };
			const snapshots = new BookSnapshots(() => current);
			const store = snapshots.store(root);
			const realSeed = store.seed.bind(store);

			let started!: () => void;
			let release!: () => void;
			const reached = new Promise<void>((resolve) => (started = resolve));
			const gate = new Promise<void>((resolve) => (release = resolve));
			const hold = mock.method(store, 'seed', async () => {
				hold.mock.restore();
				started();
				await gate;
				return realSeed();
			});

			const t0 = Date.parse('2026-04-01T16:00:00.000Z');
			const opening = snapshots.open(root, t0);
			await reached;

			const before = await index.read(chapter);
			let wrote = false;
			const saving = snapshots.write(
				root,
				async () => {
					const result = await index.save(chapter, before.text + '基线完成前发起的保存。\n', before.text);
					wrote = true;
					return result;
				},
				(result) => result.saved,
				t0 + 1_000,
			);
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.equal(wrote, false);

			release();
			await opening;
			assert.deepEqual(await saving, { saved: true });
			await snapshots.drain();

			const closed = await snapshots.close(root, t0 + 2_000);
			assert.equal(closed?.kind, 'timed');
			assert.equal((await store.read(closed!.changes![0].before!)).toString('utf8'), before.text);
			assert.equal((await store.read(closed!.changes![0].after!)).toString('utf8'), before.text + '基线完成前发起的保存。\n');
		} finally {
			index.dispose();
		}

		// With `snapshots.intervalMinutes = 0`, opening a fresh book does not scan a baseline until changed to > 0.
		const zeroRoot = exampleCopy();
		const zeroFull = path.join(zeroRoot, ...chapter.split('/'));
		const zeroOriginal = fs.readFileSync(zeroFull, 'utf8');
		const settings: Settings = { ...structuredClone(defaults), 'snapshots.intervalMinutes': 0 };
		const zeroSnapshots = new BookSnapshots(() => settings);
		const zeroStore = zeroSnapshots.store(zeroRoot);
		const spySeed = mock.method(zeroStore, 'seed');
		const t1 = Date.parse('2026-04-01T17:00:00.000Z');
		await zeroSnapshots.open(zeroRoot, t1);
		assert.equal(spySeed.mock.callCount(), 0);

		fs.writeFileSync(zeroFull, zeroOriginal + '\n间隔为0时的改动。\n');
		settings['snapshots.intervalMinutes'] = 10;
		await zeroSnapshots.reconfigure(t1 + 60_000);
		assert.equal(spySeed.mock.callCount(), 1);
		spySeed.mock.restore();

		fs.writeFileSync(zeroFull, zeroOriginal + '\n间隔为0时的改动。\n开启后新增改动。\n');
		const afterEnable = await zeroSnapshots.close(zeroRoot, t1 + 120_000);
		assert.equal(afterEnable?.kind, 'timed');
		assert.equal((await zeroStore.read(afterEnable!.changes![0].before!)).toString('utf8'), zeroOriginal + '\n间隔为0时的改动。\n');
		assert.equal(
			(await zeroStore.read(afterEnable!.changes![0].after!)).toString('utf8'),
			zeroOriginal + '\n间隔为0时的改动。\n开启后新增改动。\n',
		);
	});

	test('retains assistant and timed snapshots under separate limits and deduplicates shared blobs via hard links', async () => {
		const one = story({ '正文/第1章.md': '初稿', '设定/雾港.md': '长期不变的设定' }, 2, 3);
		const seed = await one.store.seed();

		one.write('正文/第1章.md', '手写一');
		await one.store.timed(seed);

		for (const turnText of ['助手一', '助手二', '助手三']) {
			const turn = await one.store.begin({ kind: 'turn', title: turnText });
			one.write('正文/第1章.md', turnText);
			await one.store.finish(turn.id);
		}

		for (const timedText of ['手写二', '手写三', '手写四']) {
			one.write('正文/第1章.md', timedText);
			await one.store.timed();
		}

		const records = await one.store.list();
		const turns = records.filter((record) => record.kind === 'turn');
		const timed = records.filter((record) => record.kind === 'timed');
		assert.deepEqual(
			turns.map((record) => record.title),
			['助手二', '助手三'],
		);
		assert.equal(timed.length, 3);
		assert.deepEqual(
			await Promise.all(timed.map(async (record) => (await one.store.read(record.files['正文/第1章.md'])).toString('utf8'))),
			['手写二', '手写三', '手写四'],
		);

		// Unchanged lore shares the same SHA-256 and the same underlying inode across `objects` and `timed-objects`.
		const loreHash = timed[0].files['设定/雾港.md'];
		assert.equal(loreHash, turns[0].files['设定/雾港.md']);
		const turnStat = fs.statSync(path.join(one.dir, SNAPSHOT_DIR, 'objects', loreHash.slice(0, 2), loreHash.slice(2)));
		const timedStat = fs.statSync(path.join(one.dir, SNAPSHOT_DIR, 'timed-objects', loreHash.slice(0, 2), loreHash.slice(2)));
		assert.equal(turnStat.ino, timedStat.ino);
	});

	test('reverting to a timed snapshot restores the whole book, can be undone, and changes nothing when blocked', async () => {
		const one = story({ '正文/第1章.md': '一', '正文/第2章.md': '二', '设定/雾港.md': '港' });
		const seed = await one.store.seed();
		one.write('正文/第1章.md', '一·定时点');
		const checkpoint = (await one.store.timed(seed))!;
		assert.equal(checkpoint.kind, 'timed');

		// Later edits change ch1, remove ch2, and create ch3.
		one.write('正文/第1章.md', '一·写坏了');
		one.remove('正文/第2章.md');
		one.write('正文/第3章.md', '三');

		// Put a binary file in the way of ch2: revert must refuse and leave every file untouched.
		one.write('正文/第2章.md', Buffer.from([0x89, 0x50, 0x00, 0x01]));
		assert.deepEqual(await one.store.revert(checkpoint.id), {
			blocked: [{ path: '正文/第2章.md', why: 'binary' }],
		});
		assert.equal(one.read('正文/第1章.md'), '一·写坏了');
		assert.equal(one.read('正文/第3章.md'), '三');

		// Remove the blocker: revert restores the book to `checkpoint` and creates an undoable `revert` record without `target`.
		one.remove('正文/第2章.md');
		const { record: undo, blocked } = await one.store.revert(checkpoint.id);
		assert.deepEqual(blocked, []);
		assert.equal(undo?.kind, 'revert');
		assert.equal(undo?.target, undefined);
		assert.deepEqual(one.files(), ['正文/第1章.md', '正文/第2章.md', '设定/雾港.md']);
		assert.equal(one.read('正文/第1章.md'), '一·定时点');
		assert.equal(one.read('正文/第2章.md'), '二');

		// Undoing that revert puts the book right back to where it was before reverting.
		const undone = await one.store.revert(undo!.id);
		assert.deepEqual(undone.blocked, []);
		assert.deepEqual(one.files(), ['正文/第1章.md', '正文/第3章.md', '设定/雾港.md']);
		assert.equal(one.read('正文/第1章.md'), '一·写坏了');
		assert.equal(one.read('正文/第3章.md'), '三');
	});

	test('remains compatible with VS Code extension 0.4.0 listing, reverting, and pruning', async () => {
		const one = story({ '正文/第1章.md': '初稿', '设定/雾港.md': '港' });
		const seed = await one.store.seed();

		one.write('正文/第1章.md', '仅在定时快照里的手写稿');
		const timedOnly = (await one.store.timed(seed))!;

		const turn1 = await one.store.begin({ kind: 'turn', title: '扩展第一轮' });
		one.write('正文/第1章.md', '助手第一版');
		await one.store.finish(turn1.id);

		// Simulate VS Code extension 0.4.0 (`vscode-extension:src/storage/snapshotStore.ts`):
		// it reads only `turns/*.json` and prunes `objects/*` against `referenced(turns)` with `keep = 1`.
		const turnsDir = path.join(one.dir, SNAPSHOT_DIR, 'turns');
		const objectsDir = path.join(one.dir, SNAPSHOT_DIR, 'objects');
		const extList = (): SnapshotRecord[] =>
			fs
				.readdirSync(turnsDir)
				.filter((name) => name.endsWith('.json'))
				.map((name) => parseRecord(fs.readFileSync(path.join(turnsDir, name), 'utf8'))!)
				.filter(Boolean)
				.sort((a, b) => a.id - b.id);

		// Extension 0.4.0 sees only `turn` / `revert` records in `turns/`, never unknown `timed` records.
		assert.deepEqual(
			extList().map((record) => [record.id, record.kind]),
			[[1, 'turn']],
		);

		// Extension 0.4.0 runs a second turn with `keep = 1`, expiring turn 1 and pruning `objects/` of anything turn 2 does not reference!
		const turn2 = await one.store.begin({ kind: 'turn', title: '扩展第二轮' });
		one.write('正文/第1章.md', '助手第二版');
		await one.store.finish(turn2.id);

		const survivingTurns = extList();
		for (const id of expired(
			survivingTurns.map((record) => record.id),
			1,
		)) {
			fs.rmSync(path.join(turnsDir, `${String(id).padStart(6, '0')}.json`), { force: true });
		}
		const extNeeded = referenced(extList());
		for (const prefix of fs.readdirSync(objectsDir)) {
			for (const name of fs.readdirSync(path.join(objectsDir, prefix))) {
				if (!extNeeded.has(prefix + name)) {
					fs.rmSync(path.join(objectsDir, prefix, name), { force: true });
				}
			}
		}

		// Even after extension 0.4.0 pruned `objects/`, the Mac app still reads both sides of `timedOnly` and reverts to it cleanly.
		assert.equal(afterManifest(timedOnly)['正文/第1章.md'], timedOnly.files['正文/第1章.md']);
		assert.equal((await one.store.read(timedOnly.changes![0].before!)).toString('utf8'), '初稿');
		assert.equal((await one.store.read(timedOnly.changes![0].after!)).toString('utf8'), '仅在定时快照里的手写稿');
		const reverted = await one.store.revert(timedOnly.id);
		assert.deepEqual(reverted.blocked, []);
		assert.equal(one.read('正文/第1章.md'), '仅在定时快照里的手写稿');
		// And the revert record written by the Mac app in `turns/` is valid for extension 0.4.0 too.
		assert.deepEqual(
			extList().map((record) => record.kind),
			['turn', 'revert'],
		);
	});
});
