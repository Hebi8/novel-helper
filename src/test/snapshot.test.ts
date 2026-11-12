// Snapshots of a story folder: what is kept, what a turn is found to have
// changed, going back, and what is thrown away.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsp = require('node:fs/promises');
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { changeKind, diff, expired, looksBinary, MAX_FILE_BYTES, parseRecord, referenced, restorePlan, skipsFolder, SNAPSHOT_DIR, titleOf } from '../core/snapshot';
import { SnapshotStore } from '../storage/snapshotStore';
import { filesIn } from './vscodeStub';

const made: string[] = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A story folder with these files, and its store. */
function story(files: Record<string, string | Buffer>, keep = 50) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-snapshot-'));
	made.push(dir);
	const write = (file: string, content: string | Buffer = '') => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), content);
	};
	Object.entries(files).forEach(([file, content]) => write(file, content));
	return {
		dir,
		store: new SnapshotStore(dir, () => keep),
		write,
		remove: (file: string) => fs.rmSync(path.join(dir, file)),
		read: (file: string) => fs.readFileSync(path.join(dir, file), 'utf8'),
		/** The story's own files, the snapshots aside. */
		files: () => filesIn(dir).filter((file) => !file.startsWith(`${SNAPSHOT_DIR}/`)),
		objects: () => filesIn(path.join(dir, SNAPSHOT_DIR, 'objects')).length,
	};
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
		const changes = diff({ '正文/第10章.md': 'a', '正文/第2章.md': 'b', '设定/旧.md': 'c', '大纲/全书.md': 'd' }, { '正文/第10章.md': 'a2', '正文/第2章.md': 'b2', '正文/第3章.md': 'e', '大纲/全书.md': 'd' });
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
		const hashes = referenced([{ id: 1, time: '', kind: 'turn', files: { a: 'h1' }, changes: [{ path: 'a', before: 'h1', after: 'h2' }, { path: 'b', after: 'h3' }] }]);
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
		assert.deepEqual(back?.changes?.map((change) => `${changeKind(change)} ${change.path}`), ['modified 正文/第1章.md', 'added 正文/第2章.md', 'removed 正文/第3章.md']);

		await one.store.revert(back!.id);
		assert.deepEqual(one.files(), ['正文/第1章.md', '正文/第3章.md', '资料/地图.png']);
		assert.equal(one.read('正文/第1章.md'), '一改，又手改');
		assert.deepEqual((await one.store.list()).map((record) => record.kind), ['turn', 'turn', 'revert', 'revert']);
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
		assert.deepEqual(records.map((record) => record.title), ['3', '4']);
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
		assert.deepEqual((await again.list()).map((kept) => kept.id), [record.id]);
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
		assert.deepEqual(records.map((record) => record.id).sort(), [1, 2]);
		assert.deepEqual((await one.store.list()).map((record) => record.title).sort(), ['乙', '甲']);
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
		assert.deepEqual((await one.store.list()).map((record) => record.id), [1, 2]);
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
