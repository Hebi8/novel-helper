import * as assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { suggestChapterName } from '../core/book';
import { conflictCandidate, conflictOriginal, findConflictCopies } from '../core/conflict';
import { readAuxiliaryOptional } from '../main/book/files';
import { BookIndex } from '../main/book/indexer';
import { Buoys } from '../main/buoys/service';
import { renameBook, renamePlan } from '../main/scaffold/rename';
import { SettingsStore } from '../main/settings/store';
import { UsageStore } from '../storage/usageStore';

describe('conflict copy detection', () => {
	test('matches stem + space + integer >= 2 + .md only when the original .md exists in the same folder', () => {
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

		assert.equal(conflictCandidate('正文/第2章 灯塔 2.md'), '正文/第2章 灯塔.md');
		assert.equal(conflictCandidate('正文/第2章 灯塔 1.md'), undefined);
		assert.equal(conflictCandidate('正文/第2章 灯塔 0.md'), undefined);
		assert.equal(conflictCandidate('正文/第2章 灯塔 02.md'), undefined);
		assert.equal(conflictCandidate('正文/文本 2.txt'), undefined);
		assert.equal(conflictCandidate('.hidden 2.md'), undefined);

		assert.equal(conflictOriginal('正文/第2章 灯塔 2.md', files), '正文/第2章 灯塔.md');
		assert.equal(conflictOriginal('正文/孤本 2.md', files), undefined);
		assert.equal(conflictOriginal('正文/只有txt 2.md', files), undefined);
		assert.equal(conflictOriginal('其他/第2章 灯塔 4.md', files), undefined);

		assert.deepEqual(findConflictCopies(files), [
			{ path: '正文/第2章 灯塔 2.md', original: '正文/第2章 灯塔.md' },
			{ path: '正文/第2章 灯塔 3.md', original: '正文/第2章 灯塔.md' },
			{ path: '正文/第2章 灯塔 10.md', original: '正文/第2章 灯塔.md' },
		]);
	});

	test('resolves chained copies to the non-conflict original and supports .json when requested', () => {
		assert.deepEqual(findConflictCopies(['设定/雾港.md', '设定/雾港 2.md', '设定/雾港 2 2.md']), [
			{ path: '设定/雾港 2.md', original: '设定/雾港.md' },
			{ path: '设定/雾港 2 2.md', original: '设定/雾港.md' },
		]);

		assert.deepEqual(
			findConflictCopies(
				[
					'.novel-helper/project.json',
					'.novel-helper/project 2.json',
					'.novel-helper/buoys/正文/第2章 灯塔.md.json',
					'.novel-helper/buoys/正文/第2章 灯塔.md 3.json',
				],
				['.json'],
			),
			[
				{ path: '.novel-helper/buoys/正文/第2章 灯塔.md 3.json', original: '.novel-helper/buoys/正文/第2章 灯塔.md.json' },
				{ path: '.novel-helper/project 2.json', original: '.novel-helper/project.json' },
			],
		);
	});

	test('excludes conflict copies from library numbering, sorting, outlines, and lore matching while tracking transitions', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-conflict-test-'));
		const book = join(root, 'book');
		await cp(resolve('examples'), book, { recursive: true });
		t.after(() => rm(root, { recursive: true, force: true }));

		const chapterOriginal = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
		const chapterCopy = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔 2.md';
		const outlineOriginal = '大纲/第一卷 雾港.md';
		const outlineCopy = '大纲/第一卷 雾港 2.md';
		const loreOriginal = '人物/林小满.md';
		const loreCopy = '人物/林小满 2.md';
		const orphanTwo = '正文/第一卷 雾港/第一幕 来信/第3章 远航 2.md';

		await writeFile(join(book, chapterCopy), '冲突章节正文');
		await writeFile(join(book, outlineCopy), '# 冲突卷纲\n\n## 多出来的节点\n');
		await writeFile(join(book, loreCopy), '---\naliases: [冲突独有称呼]\nalways: true\n---\n冲突人物卡片。');
		await writeFile(join(book, orphanTwo), '没有原文件的第3章 远航 2');

		const index = new BookIndex(book);
		t.after(() => index.dispose());
		await index.load();

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

		// Remove orphanTwo first so chapter numbering checks chapterCopy alone.
		await rm(join(book, orphanTwo));
		await index.refresh(orphanTwo);
		assert.equal(suggestChapterName(index.book.tree, index.book.tree, '第1章 '), '第3章 ');

		// If the original chapter is deleted, the copy is no longer a conflict copy and joins the library.
		await rm(join(book, chapterOriginal));
		await index.refresh(chapterOriginal);
		assert.equal(index.library.isChapter(chapterCopy), true);
		assert.equal(index.book.conflicts.some((item) => item.path === chapterCopy), false);
	});

	test('ignores .json conflict copies of project.json and buoy files without errors, display, or merging', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-aux-conflict-test-'));
		const book = join(root, 'book');
		await cp(resolve('examples'), book, { recursive: true });
		t.after(() => rm(root, { recursive: true, force: true }));

		const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
		const buoyConflict = '.novel-helper/buoys/正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md 2.json';
		const markerConflict = '.novel-helper/project 2.json';
		await writeFile(join(book, markerConflict), '{not-valid-json');
		await writeFile(join(book, buoyConflict), '{not-valid-json');

		assert.equal(await readAuxiliaryOptional(book, markerConflict), undefined);
		assert.equal(await readAuxiliaryOptional(book, buoyConflict), undefined);

		const index = new BookIndex(book);
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
});
