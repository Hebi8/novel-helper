import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, link, unlink, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { EditorState } from '@codemirror/state';
import { openCompanion } from '../main/reference/service';
import { initialization, initialize, prepareOpen } from '../main/scaffold/initialize';
import { createFile, info } from '../main/scaffold/disk';
import { createStructure, structureSuggestion } from '../main/scaffold/structure';
import { renameBook } from '../main/scaffold/rename';
import { atomicWrite } from '../main/book/files';
import { searchBook, searchTexts } from '../main/search/search';
import { BookIndex } from '../main/book/indexer';
import { MARKER_FILE } from '../core/story';
import { parseBuoyFile, renameState, serializeBuoyFile } from '../core/buoy';
import { defaults } from '../shared/defaults';
import { saveSettingText, settingGroups } from '../shared/settings';
import { searchExcerpt } from '../shared/search';
import { shouldCenter } from '../renderer/editor/preferences';
import { SettingsStore } from '../main/settings/store';
import { movedPath } from '../shared/paths';
import { filesIn } from './files';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const operations = { link, unlink, rename, write: atomicWrite };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-scaffold-'))),
		book = join(root, 'book');
	await cp(resolve('examples'), book, { recursive: true });
	const index = new BookIndex(book);
	await index.load();
	t.after(async () => {
		index.dispose();
		await rm(root, { recursive: true, force: true });
	});
	return { root, book, index };
}
async function contents(book: string) {
	return Object.fromEntries(
		await Promise.all(filesIn(book).map(async (path) => [path, (await readFile(join(book, path))).toString('base64')])),
	);
}
test('initialization lists only absent items and never overwrites existing files or markers', async (t) => {
	const { book } = await fixture(t);
	await mkdir(join(book, 'outlines'));
	await writeFile(join(book, 'outlines/book.md'), 'Keep');
	const plan = await initialization(book, 'en', defaults);
	assert.ok(!plan.items.some((item) => ['outlines', 'outlines/book.md'].includes(item.path)));
	const marker = await readFile(join(book, MARKER_FILE), 'utf8');
	await initialize(book, 'en', ['chapters', 'outlines/book.md', 'lore/Style.md'], defaults);
	assert.equal(await readFile(join(book, 'outlines/book.md'), 'utf8'), 'Keep');
	assert.match(await readFile(join(book, 'lore/Style.md'), 'utf8'), /always: true/);
	assert.equal(await readFile(join(book, MARKER_FILE), 'utf8'), marker);
	await assert.rejects(createFile(book, 'outlines/book.md', 'overwrite'));
});
test('a directory containing only a PDF or empty default folders is not marked as a book', async (t) => {
	const { root } = await fixture(t);
	const folder = join(root, 'ordinary');
	await mkdir(join(folder, '资料'), { recursive: true });
	await writeFile(join(folder, '资料/a.pdf'), 'pdf');
	assert.equal((await prepareOpen(folder, defaults)).initialize, true);
	assert.equal(await info(join(folder, MARKER_FILE)), undefined);
	await mkdir(join(folder, 'chapters'));
	assert.equal((await prepareOpen(folder, defaults)).initialize, true);
	assert.equal(await info(join(folder, MARKER_FILE)), undefined);
});
test('an unmarked book is marked before discovering nested books and its index is loaded once', async (t) => {
	const { book } = await fixture(t);
	await rm(join(book, MARKER_FILE));
	await mkdir(join(book, 'child/.novel-helper'), { recursive: true });
	await writeFile(join(book, 'child', MARKER_FILE), '{"version":1}');
	const before = await contents(book);
	const load = BookIndex.prototype.load;
	let loads = 0;
	t.mock.method(BookIndex.prototype, 'load', async function (this: BookIndex) {
		loads++;
		await load.call(this);
	});
	const result = await prepareOpen(book, defaults);
	assert.equal(loads, 1);
	assert.equal(result.index?.root, book);
	assert.equal(result.roots, undefined);
	const after = await contents(book);
	for (const [path, content] of Object.entries(before)) {
		assert.equal(after[path], content);
	}
	assert.ok(await info(join(book, MARKER_FILE)));
	result.index?.dispose();
});
test('story discovery finds marked children through four levels only', async (t) => {
	const { root, book } = await fixture(t);
	for (const path of ['one/two/three/four', 'one/two/three/four/five', '.hidden/book', 'node_modules/book']) {
		await mkdir(join(root, path, '.novel-helper'), { recursive: true });
		await writeFile(join(root, path, MARKER_FILE), '{"version":1}');
	}
	assert.deepEqual((await prepareOpen(root, defaults)).roots, [book, join(root, 'one/two/three/four')]);
});
test('chapter numbering follows the active level and a new level contains its first chapter', async (t) => {
	const { index, book } = await fixture(t);
	const suggestion = await structureSuggestion(index, 'chapter', chapter);
	assert.equal(suggestion.name, '第3章 ');
	const path = await createStructure(index, { action: 'chapter', path: chapter, name: 'Chapter 3' });
	assert.equal(path, `${dirname(chapter)}/Chapter 3.md`);
	await assert.rejects(createStructure(index, { action: 'chapter', path, name: 'Chapter 3' }));
	assert.equal(await readFile(join(book, path), 'utf8'), '');
	const first = await createStructure(index, { action: 'level', path: index.book.tree.path, name: 'Volume 2', chapter: 'Chapter 4' });
	assert.equal(first, '正文/Volume 2/Chapter 4.md');
	await assert.rejects(createStructure(index, { action: 'level', path: index.book.tree.path, name: 'Volume 2', chapter: 'Other' }));
	assert.equal(await info(join(book, '正文/Volume 2/Other.md')), undefined);
});
test('English initialization names the first chapter, volume and outline using the cached marker', async (t) => {
	const { root } = await fixture(t),
		book = join(root, 'new');
	await mkdir(book);
	await initialize(book, 'en', ['chapters'], defaults);
	const { index } = await prepareOpen(book, defaults);
	assert.equal((await structureSuggestion(index!, 'chapter')).name, 'Chapter 1 ');
	assert.equal((await structureSuggestion(index!, 'level')).name, 'Volume 1 ');
	assert.equal(await openCompanion(index!, index!.book.tree.path, 'outline'), 'outlines/book.md');
	index!.dispose();
});
test('chapter rename carries outlines, summaries and buoy records using the core transform', async (t) => {
	const { index, book } = await fixture(t);
	const summary = chapter.replace('正文/', '摘要/');
	await mkdir(dirname(join(book, summary)), { recursive: true });
	await writeFile(join(book, summary), 'Summary');
	await index.refresh(summary);
	const oldBuoy = parseBuoyFile(await readFile(join(book, `.novel-helper/buoys/${chapter}.json`), 'utf8'))!;
	const before = await contents(book);
	const result = await index.exclusive(() => renameBook(index, chapter, 'Chapter 2 Light'));
	assert.equal(result.error, undefined);
	const next = movedPath(chapter, result.renames);
	for (const path of [chapter, chapter.replace('正文/', '大纲/'), summary]) {
		assert.equal(await info(join(book, path)), undefined);
		assert.equal((await readFile(join(book, movedPath(path, result.renames)))).toString('base64'), before[path]);
	}
	const expected = {
		...oldBuoy,
		chapter: next,
		marks: oldBuoy.marks.map((mark) => ({ ...mark, state: renameState(mark.state, result.renames) })),
	};
	assert.equal(await readFile(join(book, `.novel-helper/buoys/${next}.json`), 'utf8'), serializeBuoyFile(expected));
	assert.ok(index.library.isChapter(next));
});
test('level rename moves descendants while retaining the book directory identity', async (t) => {
	const { index, book } = await fixture(t),
		level = index.book.tree.children[0];
	const inode = (await info(book))!.ino;
	const result = await index.exclusive(() => renameBook(index, level.path, 'Volume 1'));
	assert.equal(result.error, undefined);
	assert.equal((await info(book))!.ino, inode);
	assert.ok(await info(join(book, movedPath(chapter, result.renames))));
	assert.ok(await info(join(book, '大纲/Volume 1.md')));
});
test('preflight conflicts in companions and buoy destinations leave every file untouched', async (t) => {
	const { index, book } = await fixture(t),
		target = `${dirname(chapter.replace('正文/', '大纲/'))}/Taken.md`;
	await writeFile(join(book, target), 'Existing');
	let before = await contents(book);
	await assert.rejects(index.exclusive(() => renameBook(index, chapter, 'Taken')));
	assert.deepEqual(await contents(book), before);
	await rm(join(book, target));
	await writeFile(join(book, `.novel-helper/buoys/${dirname(chapter)}/Taken.md.json`), '{}');
	before = await contents(book);
	await assert.rejects(index.exclusive(() => renameBook(index, chapter, 'Taken')));
	assert.deepEqual(await contents(book), before);
});
test('case-only rename is rejected and identical names are a no-op', async (t) => {
	const { index, book } = await fixture(t);
	const path = await createStructure(index, { action: 'chapter', path: chapter, name: 'Chapter 3' });
	const before = await contents(book);
	await assert.rejects(
		index.exclusive(() => renameBook(index, path, 'chapter 3')),
		/大小写/,
	);
	assert.deepEqual(await contents(book), before);
	assert.deepEqual(await index.exclusive(() => renameBook(index, path, 'Chapter 3')), { renames: [] });
});
test('an unsupported link fails before any rename, including when renaming a volume', async (t) => {
	const { index, book } = await fixture(t),
		before = await contents(book);
	const result = await index.exclusive(() =>
		renameBook(index, index.book.tree.children[0].path, 'Next', {
			...operations,
			link: async () => {
				throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
			},
		}),
	);
	assert.deepEqual(result.renames, []);
	assert.match(result.error!, /磁盘不支持/);
	assert.deepEqual(await contents(book), before);
});
test('a mid-rename failure returns completed paths and the index is rebuilt', async (t) => {
	const { index, book } = await fixture(t);
	let count = 0;
	const result = await index.exclusive(() =>
		renameBook(index, chapter, 'Next', {
			...operations,
			link: async (from, to) => {
				if (++count === 2) {
					throw new Error('injected failure');
				}
				await link(from, to);
			},
		}),
	);
	assert.equal(result.renames.length, 1);
	assert.match(result.error!, /已改名/);
	assert.match(result.error!, /未改名/);
	const next = movedPath(chapter, result.renames);
	assert.ok(index.library.isChapter(next));
	assert.equal(index.library.isChapter(chapter), false);
	const document = await index.read(next);
	assert.deepEqual(await index.save(next, document.text + ' More', document.text), { saved: true });
	assert.match(await readFile(join(book, next), 'utf8'), / More$/);
});
test('exclusive rebuilds the index even when the operation throws', async (t) => {
	const { index, book } = await fixture(t),
		next = `${dirname(chapter)}/Changed.md`;
	await assert.rejects(
		index.exclusive(async () => {
			await rename(join(book, chapter), join(book, next));
			throw new Error('failed');
		}),
	);
	assert.ok(index.library.isChapter(next));
	assert.equal(index.library.isChapter(chapter), false);
});
test('symlinks and unparseable buoy records stop before any rename', async (t) => {
	const { index, book, root } = await fixture(t),
		target = `${dirname(chapter)}/Taken.md`;
	await symlink(join(root, 'missing'), join(book, target));
	await assert.rejects(
		index.exclusive(() => renameBook(index, chapter, 'Taken')),
		/符号链接/,
	);
	await rm(join(book, target));
	await writeFile(join(book, `.novel-helper/buoys/${chapter}.json`), '{broken');
	const before = await contents(book);
	await assert.rejects(
		index.exclusive(() => renameBook(index, chapter, 'Next')),
		/浮标/,
	);
	assert.deepEqual(await contents(book), before);
});
test('JSON parsing errors never save and groups cover all settings', async (t) => {
	const { root } = await fixture(t),
		store = new SettingsStore(join(root, 'settings'));
	store.set('extraRequestBody', { temperature: 0.5 });
	const before = await readFile(join(root, 'settings/settings.json'), 'utf8');
	await assert.rejects(saveSettingText('extraRequestBody', '{bad', async (key, value) => store.set(key, value)));
	assert.equal(await readFile(join(root, 'settings/settings.json'), 'utf8'), before);
	assert.deepEqual(settingGroups.flatMap((group) => group.keys).sort(), Object.keys(defaults).sort());
});
test('directory settings rebuild chapter classification', async (t) => {
	const { book, index } = await fixture(t);
	await mkdir(join(book, 'manuscripts'));
	await writeFile(join(book, 'manuscripts/one.txt'), 'Words');
	await index.reconfigure({ ...defaults, 'files.chapters': ['manuscripts/*.txt'] });
	assert.deepEqual(index.library.chapterList(), ['manuscripts/one.txt']);
});
test('literal case-insensitive search groups files and caps displayed matches at 200', () => {
	const result = searchTexts(
		[
			{ path: 'a.md', text: 'First A+B\nsecond a+b a+b' },
			{ path: 'b.txt', text: 'a+b\n'.repeat(205) },
		],
		'a+B',
	);
	assert.equal(result.total, 208);
	assert.equal(result.groups.flatMap((group) => group.matches).length, 200);
	assert.deepEqual(
		result.groups.map((group) => group.path),
		['a.md', 'b.txt'],
	);
	assert.equal(result.groups[0].matches[1].offset, 17);
	assert.deepEqual(searchTexts([], ''), { total: 0, groups: [], skipped: [] });
});
test('search skips GBK and mixed-newline files while returning every other matching file', async (t) => {
	const { book } = await fixture(t);
	for (const path of ['正文/search.md', '大纲/search.md', '设定/search.txt', '摘要/search.md', 'notes/search.txt']) {
		await mkdir(dirname(join(book, path)), { recursive: true });
		await writeFile(join(book, path), 'Needle');
	}
	await writeFile(join(book, '设定/gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
	await writeFile(join(book, '设定/mixed.txt'), 'one\r\ntwo\n');
	const result = await searchBook(book, 'needle');
	assert.equal(result.total, 5);
	assert.deepEqual(result.skipped.map((file) => file.path).sort(), ['设定/gbk.txt', '设定/mixed.txt']);
});
test('search excerpts keep long paragraph hits visible and preserve source offsets', () => {
	const result = searchTexts([{ path: 'notes.md', text: 'İ 🐈 ' + '前'.repeat(500) + 'NEEDLE' + '后'.repeat(500) }], 'needle');
	const match = result.groups[0].matches[0],
		excerpt = searchExcerpt(match);
	assert.equal(match.offset, 505);
	assert.equal(excerpt.hit, 'NEEDLE');
	assert.equal(excerpt.before, '…' + '前'.repeat(35));
	assert.equal(excerpt.after, '后'.repeat(65) + '…');
});
test('pointer selection never centers while keyboard movement and typing do', () => {
	const state = EditorState.create({ doc: 'one\ntwo' });
	const change = (userEvent: string) => {
		const tr = state.update({ selection: { anchor: 4 }, userEvent });
		return { docChanged: tr.docChanged, selectionSet: true, transactions: [tr] };
	};
	assert.equal(shouldCenter(change('select.pointer')), false);
	assert.equal(shouldCenter(change('select')), true);
	const typed = state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
	assert.equal(shouldCenter({ docChanged: true, selectionSet: false, transactions: [typed] }), true);
});
test('simultaneous creation never replaces the winner', async (t) => {
	const { book } = await fixture(t);
	const results = await Promise.allSettled([createFile(book, 'chapters/new.md', 'first'), createFile(book, 'chapters/new.md', 'second')]);
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	assert.equal(await readFile(join(book, 'chapters/new.md'), 'utf8'), results[0].status === 'fulfilled' ? 'first' : 'second');
});
