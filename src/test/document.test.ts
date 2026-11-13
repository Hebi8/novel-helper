import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AppAPI, SaveResult } from '../shared/api';
import { DocumentModel } from '../renderer/editor/document';
function document(save: AppAPI['book']['save']) {
	return new DocumentModel('chapter.md', '原文', { book: { save } } as AppAPI);
}
test('a dirty document holds external changes and does not autosave over them', async () => {
	let calls = 0;
	const model = document(async () => {
		calls++;
		return { saved: true };
	});
	model.edit('我的文字');
	assert.equal(model.external({ path: model.path, text: '磁盘文字' }), 'conflict');
	await model.save();
	assert.equal(model.text, '我的文字');
	assert.equal(model.conflict, '磁盘文字');
	assert.equal(calls, 0);
	model.useDisk();
	assert.equal(model.text, '磁盘文字');
	assert.equal(model.dirty, false);
	model.dispose();
});
test('a clean document reloads the disk version', () => {
	const model = document(async () => ({ saved: true }));
	assert.equal(model.external({ path: model.path, text: '新版本' }), 'reload');
	assert.equal(model.text, '新版本');
	assert.equal(model.dirty, false);
});
test('save responses do not mark newer edits as saved; tab-switch save queues behind a running write', async () => {
	let finish!: (result: SaveResult) => void;
	const calls: string[] = [];
	const model = document(async (_path, text) => {
		calls.push(text);
		return calls.length === 1
			? new Promise((resolve) => {
					finish = resolve;
				})
			: { saved: true };
	});
	model.edit('第一笔');
	const first = model.save();
	await Promise.resolve();
	model.edit('第二笔');
	const second = model.save();
	finish({ saved: true });
	await first;
	await second;
	assert.deepEqual(calls, ['第一笔', '第二笔']);
	assert.equal(model.base, '第二笔');
	assert.equal(model.dirty, false);
	model.dispose();
});
test('an external notification during an in-flight save remains a conflict when the acknowledgement arrives', async () => {
	let finish!: (result: SaveResult) => void;
	const model = document(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	model.edit('我的文字');
	const saving = model.save();
	await Promise.resolve();
	model.external({ path: model.path, text: '外部文字' });
	finish({ saved: true });
	await saving;
	assert.equal(model.conflict, '外部文字');
	assert.equal(model.text, '我的文字');
	model.dispose();
});
test('keep mine explicitly replaces the conflicting version; a stale disk check creates a conflict', async () => {
	const calls: Array<boolean | undefined> = [];
	const model = document(async (_path, _text, _base, force) => {
		calls.push(force);
		return force ? { saved: true } : { saved: false, disk: '磁盘文字' };
	});
	model.edit('我的文字');
	await model.save();
	assert.equal(model.conflict, '磁盘文字');
	await model.save(true);
	assert.deepEqual(calls, [false, true]);
	assert.equal(model.conflict, undefined);
	assert.equal(model.base, '我的文字');
	model.dispose();
});
test('keep mine resolves an external conflict even after the old save acknowledged identical local text', async () => {
	let finish!: (result: SaveResult) => void;
	let calls = 0;
	const model = document(async () =>
		++calls === 1
			? new Promise((resolve) => {
					finish = resolve;
				})
			: { saved: true },
	);
	model.edit('我的文字');
	const saving = model.save();
	await Promise.resolve();
	model.external({ path: model.path, text: '外部文字' });
	finish({ saved: true });
	await saving;
	assert.equal(model.dirty, false);
	await model.save(true);
	assert.equal(calls, 2);
	assert.equal(model.conflict, undefined);
	model.dispose();
});
test('a second external change preserves local text while the previous conflict is unresolved', async () => {
	let finish!: (result: SaveResult) => void;
	const model = document(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	model.edit('我的文字');
	const saving = model.save();
	await Promise.resolve();
	model.external({ path: model.path, text: '磁盘一' });
	finish({ saved: true });
	await saving;
	assert.equal(model.dirty, false);
	assert.equal(model.external({ path: model.path, text: '磁盘二' }), 'conflict');
	assert.equal(model.text, '我的文字');
	assert.equal(model.conflict, '磁盘二');
	model.dispose();
});
test('composition suspends the autosave timer and defers blur saves until committed text arrives', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const written: string[] = [];
	const model = document(async (_path, text) => {
		written.push(text);
		return { saved: true };
	});
	model.edit('原文。');
	model.compositionStart();
	model.edit('原文。ni');
	t.mock.timers.tick(1200);
	await Promise.resolve();
	assert.equal(written.length, 0);
	const blur = model.save();
	await Promise.resolve();
	assert.equal(written.length, 0);
	model.compositionEnd('原文。你');
	await blur;
	assert.deepEqual(written, ['原文。你']);
	model.dispose();
});
test('composition ending restarts the one second autosave pause', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let calls = 0;
	const model = document(async () => {
		calls++;
		return { saved: true };
	});
	model.compositionStart();
	model.edit('ni');
	model.compositionEnd('你');
	t.mock.timers.tick(999);
	await Promise.resolve();
	assert.equal(calls, 0);
	t.mock.timers.tick(1);
	await model.save();
	assert.equal(calls, 1);
	model.dispose();
});
