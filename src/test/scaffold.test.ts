import { openCompanion } from '../main/reference/service';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { initialization, initialize, prepareOpen } from '../main/scaffold/initialize';
import { createFile, info } from '../main/scaffold/disk';
import { createStructure, structureSuggestion } from '../main/scaffold/structure';
import { renameBook, renamePlan } from '../main/scaffold/rename';
import { searchBook, searchTexts } from '../main/search/search';
import { BookIndex } from '../main/book/indexer';
import { MARKER_FILE, parseMarker } from '../core/story';
import { defaults } from '../shared/defaults';
import { saveSettingText, settingGroups } from '../shared/settings';
import { SettingsStore } from '../main/settings/store';
import { movedPath } from '../shared/paths';
import { filesIn } from './files';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-scaffold-')));
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
async function contents(book: string) {
	return Object.fromEntries(
		await Promise.all(filesIn(book).map(async (path) => [path, (await readFile(join(book, path))).toString('base64')])),
	);
}
test('initialization lists only absent items, preserves existing files and marker, and honors selected language', async (t) => {
	const { book } = await fixture(t);
	const en = await initialization(book, 'en');
	assert.ok(en.items.some((item) => item.path === 'chapters'));
	assert.ok(en.items.some((item) => item.path === 'outlines/book.md'));
	await mkdir(join(book, 'outlines'));
	await writeFile(join(book, 'outlines/book.md'), 'Keep this outline');
	const plan = await initialization(book, 'en');
	assert.ok(!plan.items.some((item) => ['outlines', 'outlines/book.md'].includes(item.path)));
	await initialize(book, 'en', ['chapters', 'outlines/book.md', 'lore/Style.md']);
	assert.equal(await readFile(join(book, 'outlines/book.md'), 'utf8'), 'Keep this outline');
	assert.match(await readFile(join(book, 'lore/Style.md'), 'utf8'), /always: true/);
	assert.equal(await info(join(book, 'summaries')), undefined);
	await assert.rejects(createFile(book, 'outlines/book.md', 'overwrite'));
	assert.equal(await readFile(join(book, 'outlines/book.md'), 'utf8'), 'Keep this outline');
	const marker = await readFile(join(book, MARKER_FILE), 'utf8');
	await initialize(book, 'zh', []);
	assert.equal(await readFile(join(book, MARKER_FILE), 'utf8'), marker);
});
test('opening finds markers through four levels and repairs unmarked default folders without scaffolding', async (t) => {
	const { book, root } = await fixture(t);
	const before = await contents(book);
	const prepared = await prepareOpen(book);
	assert.equal(prepared.initialize, undefined);
	const after = await contents(book);
	assert.deepEqual(
		Object.keys(after).filter((path) => !(path in before)),
		[MARKER_FILE],
	);
	for (const [path, content] of Object.entries(before)) {
		assert.equal(after[path], content);
	}
	const marker = parseMarker(await readFile(join(book, MARKER_FILE), 'utf8'))!;
	assert.equal(marker.folders?.chapters, '正文');
	for (const path of ['one/two/three/four', 'one/two/three/four/five', '.hidden/hidden', 'node_modules/package']) {
		await mkdir(join(root, path, '.novel-helper'), { recursive: true });
		await writeFile(join(root, path, MARKER_FILE), '{"version":1}');
	}
	assert.deepEqual((await prepareOpen(root)).roots, [book, join(root, 'one/two/three/four')]);
	const empty = join(root, 'empty');
	await mkdir(empty);
	assert.equal((await prepareOpen(empty)).initialize, true);
	await mkdir(join(empty, 'chapters'));
	assert.equal((await prepareOpen(empty)).initialize, undefined);
	assert.deepEqual(filesIn(empty), [MARKER_FILE]);
});
test('chapter numbering follows the active level and a new level contains its first chapter', async (t) => {
	const { index, book } = await fixture(t);
	const suggestion = await structureSuggestion(index, 'chapter', chapter);
	assert.equal(suggestion.name, '第3章 ');
	const path = await createStructure(index, { action: 'chapter', path: chapter, name: suggestion.name + 'next' });
	assert.equal(path, `${dirname(chapter)}/第3章 next.md`);
	assert.equal((await structureSuggestion(index, 'chapter', path)).name, '第4章 ');
	await assert.rejects(createStructure(index, { action: 'chapter', path, name: '第3章 next' }));
	assert.equal(await readFile(join(book, path), 'utf8'), '');
	const level = await structureSuggestion(index, 'level', index.book.tree.path);
	assert.equal(level.name, '第二卷 ');
	assert.equal(level.chapter, '第4章 ');
	const first = await createStructure(index, { action: 'level', path: index.book.tree.path, name: 'Volume 2', chapter: 'Chapter 4' });
	assert.equal(first, '正文/Volume 2/Chapter 4.md');
	assert.equal(await readFile(join(book, first), 'utf8'), '');
	await assert.rejects(createStructure(index, { action: 'level', path: index.book.tree.path, name: 'Volume 2', chapter: 'Other' }));
	assert.equal(await info(join(book, '正文/Volume 2/Other.md')), undefined);
});
test('English initialization supplies English first chapter and volume names even before a chapter exists', async (t) => {
	const { root } = await fixture(t);
	const book = join(root, 'new');
	await mkdir(book);
	await initialize(book, 'en', ['chapters']);
	const index = new BookIndex(book);
	await index.load();
	assert.equal((await structureSuggestion(index, 'chapter')).name, 'Chapter 1 ');
	assert.equal((await structureSuggestion(index, 'level')).name, 'Volume 1 ');
	assert.equal(await createStructure(index, { action: 'chapter', name: 'Chapter 1' }), 'chapters/Chapter 1.md');
	index.dispose();
});
test('atomic chapter rename carries outline, summary, buoy path and every mark reference', async (t) => {
	const { index, book } = await fixture(t);
	const summary = chapter.replace('正文/', '摘要/');
	await mkdir(dirname(join(book, summary)), { recursive: true });
	await writeFile(join(book, summary), 'Summary');
	await index.refresh(summary);
	const before = await contents(book);
	const moves = await index.exclusive(() => renameBook(index, chapter, 'Chapter 2 Light'));
	const newChapter = movedPath(chapter, moves);
	assert.equal(newChapter, `${dirname(chapter)}/Chapter 2 Light.md`);
	for (const path of [chapter, chapter.replace('正文/', '大纲/'), summary]) {
		assert.equal(await info(join(book, path)), undefined);
		assert.equal((await readFile(join(book, movedPath(path, moves)))).toString('base64'), before[path]);
	}
	const buoy = JSON.parse(await readFile(join(book, `.novel-helper/buoys/${newChapter}.json`), 'utf8'));
	assert.equal(buoy.chapter, newChapter);
	assert.ok(
		buoy.marks.every((mark: { state: { nodes: { id: string }[] } }) =>
			mark.state.nodes.every((node) => !node.id.includes('第2章 灯塔.md')),
		),
	);
	assert.ok(index.library.isChapter(newChapter));
});
test('atomic level rename carries all descendants and companion directories', async (t) => {
	const { index, book } = await fixture(t);
	const level = index.book.tree.children[0];
	const before = await contents(book);
	const moves = await index.exclusive(() => renameBook(index, level.path, 'Volume 1'));
	const nextChapter = movedPath(chapter, moves);
	assert.equal((await readFile(join(book, nextChapter))).toString('base64'), before[chapter]);
	assert.equal(await info(join(book, level.path)), undefined);
	assert.ok(await info(join(book, '大纲/Volume 1.md')));
	const buoy = JSON.parse(await readFile(join(book, `.novel-helper/buoys/${nextChapter}.json`), 'utf8'));
	assert.equal(buoy.chapter, nextChapter);
	assert.ok(buoy.marks[0].state.nodes[0].id.startsWith('大纲/Volume 1/'));
});
test('a taken companion or buoy destination prevents all rename writes', async (t) => {
	const { index, book } = await fixture(t);
	const target = `${dirname(chapter.replace('正文/', '大纲/'))}/Taken.md`;
	await writeFile(join(book, target), 'Existing');
	const before = await contents(book);
	await assert.rejects(renameBook(index, chapter, 'Taken'));
	assert.deepEqual(await contents(book), before);
	await rm(join(book, target));
	await writeFile(join(book, `.novel-helper/buoys/${dirname(chapter)}/Taken.md.json`), '{}');
	const beforeBuoy = await contents(book);
	await assert.rejects(renameBook(index, chapter, 'Taken'));
	assert.deepEqual(await contents(book), beforeBuoy);
});
test('a failed final exchange leaves the entire original tree intact; no rollback is used', async (t) => {
	const { index, book } = await fixture(t);
	const before = await contents(book);
	await assert.rejects(
		renameBook(index, chapter, 'Next', async () => {
			throw new Error('exchange denied');
		}),
		/exchange denied/,
	);
	assert.deepEqual(await contents(book), before);
	assert.deepEqual(
		(await readdir(dirname(book))).filter((path) => path.includes('-rename-')),
		[],
	);
});
test('symlinks and malformed buoy records stop a rename before any original file changes', async (t) => {
	const { index, book, root } = await fixture(t);
	const target = `${dirname(chapter)}/Taken.md`;
	await symlink(join(root, 'missing'), join(book, target));
	await assert.rejects(renamePlan(index, chapter, 'Taken'));
	await rm(join(book, target));
	await writeFile(join(book, `.novel-helper/buoys/${chapter}.json`), '{broken');
	const before = await contents(book);
	await assert.rejects(renameBook(index, chapter, 'Next'));
	assert.deepEqual(await contents(book), before);
});
test('JSON parsing rejects invalid text without saving; settings groups cover all app settings', async (t) => {
	const { root } = await fixture(t);
	const store = new SettingsStore(join(root, 'settings'));
	store.set('extraRequestBody', { temperature: 0.5 });
	const before = await readFile(join(root, 'settings/settings.json'), 'utf8');
	await assert.rejects(saveSettingText('extraRequestBody', '{bad', async (key, value) => store.set(key, value)));
	await assert.rejects(saveSettingText('assistant.args', '{}', async (key, value) => store.set(key, value)));
	assert.equal(await readFile(join(root, 'settings/settings.json'), 'utf8'), before);
	assert.deepEqual(store.get().extraRequestBody, { temperature: 0.5 });
	await saveSettingText('assistant.args', '["--test", "value"]', async (key, value) => store.set(key, value));
	assert.deepEqual(store.get()['assistant.args'], ['--test', 'value']);
	assert.deepEqual(
		settingGroups.flatMap((group) => group.keys).sort(),
		Object.keys(defaults)
			.filter((key) => key !== 'files.storyFolder')
			.sort(),
	);
});
test('directory settings rebuild the index and change chapter classification', async (t) => {
	const { book, index } = await fixture(t);
	await mkdir(join(book, 'manuscripts'));
	await writeFile(join(book, 'manuscripts/one.txt'), 'Words');
	await index.reconfigure({ ...defaults, 'files.chapters': ['manuscripts/*.txt'] });
	assert.deepEqual(index.library.chapterList(), ['manuscripts/one.txt']);
	assert.equal(index.library.isChapter(chapter), false);
});
test('search is literal and case-insensitive, groups files, records offsets, and caps displayed matches at 200', () => {
	const result = searchTexts(
		[
			{ path: 'a.md', text: 'First A+B\nsecond a+b a+b' },
			{ path: 'b.txt', text: 'a+b\n'.repeat(205) },
		],
		'a+B',
	);
	assert.equal(result.total, 208);
	assert.deepEqual(
		result.groups.map((group) => group.path),
		['a.md', 'b.txt'],
	);
	assert.equal(result.groups.flatMap((group) => group.matches).length, 200);
	assert.equal(result.groups[0].matches[1].offset, 17);
	assert.equal(result.groups[0].matches[1].line, 1);
	assert.deepEqual(searchTexts([{ path: 'a.md', text: 'anything' }], ''), { total: 0, groups: [] });
});
test('disk search includes prose, lore, outlines, summaries and other md/txt files', async (t) => {
	const { book } = await fixture(t);
	for (const path of ['正文/search.md', '大纲/search.md', '设定/search.txt', '摘要/search.md', 'notes/search.txt']) {
		await mkdir(dirname(join(book, path)), { recursive: true });
		await writeFile(join(book, path), 'Needle');
	}
	await writeFile(join(book, 'notes/search.json'), 'Needle');
	const result = await searchBook(book, 'needle');
	assert.equal(result.total, 5);
	assert.equal(result.groups.length, 5);
});

test('renaming discovers a companion that was just created before the watcher ran', async (t) => {
	const { index, book } = await fixture(t);
	const summary = chapter.replace('正文/', '摘要/');
	await mkdir(dirname(join(book, summary)), { recursive: true });
	await writeFile(join(book, summary), 'New summary');
	const moves = await renameBook(index, chapter, 'Recent');
	assert.equal(await readFile(join(book, movedPath(summary, moves)), 'utf8'), 'New summary');
	assert.equal(await info(join(book, summary)), undefined);
});

test('duplicate buoy keys and invalid UTF-8 stop lossless rewriting', async (t) => {
	const { index, book } = await fixture(t);
	const path = join(book, `.novel-helper/buoys/${chapter}.json`);
	await writeFile(path, '{"chapter":"first","chapter":"second","marks":[]}');
	let before = await contents(book);
	await assert.rejects(renameBook(index, chapter, 'Next'));
	assert.deepEqual(await contents(book), before);
	await writeFile(path, Buffer.concat([Buffer.from('{"chapter":"'), Buffer.from([0xff]), Buffer.from('","marks":[]}')]));
	before = await contents(book);
	await assert.rejects(renameBook(index, chapter, 'Next'));
	assert.deepEqual(await contents(book), before);
});

test('invalid existing project markers are reported without replacement', async (t) => {
	const { book } = await fixture(t);
	await mkdir(join(book, '.novel-helper'), { recursive: true });
	await writeFile(join(book, MARKER_FILE), '{broken');
	const before = await contents(book);
	await assert.rejects(prepareOpen(book), /project.json/);
	assert.deepEqual(await contents(book), before);
});

test('English marker names are used for the first companion in an empty book', async (t) => {
	const { root } = await fixture(t);
	const book = join(root, 'empty-en');
	await mkdir(book);
	await initialize(book, 'en', ['chapters']);
	const index = new BookIndex(book);
	await index.load();
	assert.equal(index.book.tree.name, 'book');
	assert.equal(await openCompanion(index, index.book.tree.path, 'outline'), 'outlines/book.md');
	index.dispose();
});

test('simultaneous creation never replaces the winner', async (t) => {
	const { book } = await fixture(t);
	const results = await Promise.allSettled([createFile(book, 'chapters/new.md', 'first'), createFile(book, 'chapters/new.md', 'second')]);
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	assert.equal(await readFile(join(book, 'chapters/new.md'), 'utf8'), results[0].status === 'fulfilled' ? 'first' : 'second');
	assert.deepEqual(await readdir(join(book, 'chapters')), ['new.md']);
});

test('case conversion and emoji never shift search offsets in the source text', () => {
	const result = searchTexts([{ path: 'notes.md', text: 'İ 🐈 NEEDLE' }], 'needle');
	assert.equal(result.groups[0].matches[0].offset, 5);
	assert.equal(result.groups[0].matches[0].text.slice(result.groups[0].matches[0].column), 'NEEDLE');
});
