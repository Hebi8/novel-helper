import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type BookNode, globRootDepth, Library, parseLoreEntry } from '../core/library';

describe('parseLoreEntry', () => {
	test('no frontmatter: name from the file name', () => {
		const e = parseLoreEntry('人物/林小满.md', '镇上的信使。\n');
		assert.equal(e.name, '林小满');
		assert.deepEqual(e.aliases, []);
		assert.equal(e.always, false);
		assert.equal(e.body, '镇上的信使。');
		assert.deepEqual(e.keys, ['林小满']);
	});

	test('all frontmatter fields', () => {
		const e = parseLoreEntry(
			'人物/lin.md',
			'---\nname: 林小满\naliases: [小满, 林姑娘]\ntype: 人物\nalways: true\nsummary: 雾港的信使\n---\n\n正文\n',
		);
		assert.equal(e.id, '人物/lin.md');
		assert.equal(e.name, '林小满');
		assert.deepEqual(e.aliases, ['小满', '林姑娘']);
		assert.equal(e.type, '人物');
		assert.equal(e.always, true);
		assert.equal(e.summary, '雾港的信使');
		assert.equal(e.body, '正文');
		assert.deepEqual(e.keys, ['林小满', '小满', '林姑娘']);
	});

	test('aliases as a block list or a comma-separated string; duplicates of the name dropped', () => {
		assert.deepEqual(parseLoreEntry('a.md', '---\naliases:\n  - 甲\n  - 乙\n---\n').aliases, ['甲', '乙']);
		assert.deepEqual(parseLoreEntry('a.md', '---\naliases: 甲，乙、丙, 丁\n---\n').aliases, ['甲', '乙', '丙', '丁']);
		assert.deepEqual(parseLoreEntry('张三.md', '---\naliases: [张三, 三哥]\n---\n').keys, ['张三', '三哥']);
	});

	test('only `always: true` makes an entry always-on', () => {
		assert.equal(parseLoreEntry('a.md', '---\nalways: "yes"\n---\n').always, false);
		assert.equal(parseLoreEntry('a.md', '---\nalways: false\n---\n').always, false);
	});

	test('invalid YAML: defaults plus an error, body still read', () => {
		const e = parseLoreEntry('设定/灯塔.md', '---\nname: [unclosed\n---\n北角的灯塔。');
		assert.equal(e.name, '灯塔');
		assert.ok(e.error);
		assert.equal(e.body, '北角的灯塔。');
	});

	test('empty frontmatter and Windows line endings', () => {
		assert.equal(parseLoreEntry('a.md', '---\n---\n正文').body, '正文');
		assert.equal(parseLoreEntry('a.md', '---\r\nname: 甲\r\n---\r\n正文').name, '甲');
	});
});

describe('Library', () => {
	test('matcher follows lore changes', () => {
		const lib = new Library();
		lib.setLore('人物/张三.md', '---\naliases: [三哥]\n---\n');
		assert.deepEqual(lib.matcher().find('三哥来了').map((m) => m.ids), [['人物/张三.md']]);
		lib.setLore('人物/张三丰.md', '');
		assert.equal(lib.matcher().find('张三丰')[0].key, '张三丰');
		lib.deleteLore('人物/张三丰.md');
		assert.equal(lib.matcher().find('张三丰')[0].key, '张三');
	});

	test('chapters in natural order; previous chapters oldest first', () => {
		const lib = new Library();
		for (const p of ['正文/第10章.md', '正文/第2章.md', '正文/第一章.md', '正文/第3章.md']) {
			lib.addFile('chapter', p);
		}
		assert.deepEqual(lib.chapterList(), ['正文/第一章.md', '正文/第2章.md', '正文/第3章.md', '正文/第10章.md']);
		assert.deepEqual(lib.previousChapters('正文/第10章.md', 2), ['正文/第2章.md', '正文/第3章.md']);
		assert.deepEqual(lib.previousChapters('正文/第一章.md', 3), []);
		assert.deepEqual(lib.previousChapters('草稿.md', 3), []);
		lib.deleteFile('chapter', '正文/第3章.md');
		assert.deepEqual(lib.previousChapters('正文/第10章.md', 1), ['正文/第2章.md']);
		assert.equal(lib.isChapter('正文/第3章.md'), false);
	});

	test('outline and summary files pair with chapters by name and folder', () => {
		const lib = new Library();
		for (const p of ['正文/卷一/第1章.txt', '正文/卷二/第1章.md', '正文/卷三/第1章.md', '正文/第2章 灯塔.md', '正文/第3章.md']) {
			lib.addFile('chapter', p);
		}
		lib.addFile('outline', '大纲/卷一/第1章.md');
		lib.addFile('outline', '大纲/卷二/第1章.md');
		lib.addFile('summary', '摘要/第2章 灯塔.md');
		assert.equal(lib.companionOf('outline', '正文/卷二/第1章.md'), '大纲/卷二/第1章.md');
		assert.equal(lib.companionOf('outline', '正文/卷一/第1章.txt'), '大纲/卷一/第1章.md');
		assert.equal(lib.companionOf('outline', '正文/卷三/第1章.md'), undefined, 'not the outline of another volume');
		assert.equal(lib.companionOf('summary', '正文/第2章 灯塔.md'), '摘要/第2章 灯塔.md');
		assert.equal(lib.companionOf('summary', '正文/第3章.md'), undefined);
		lib.deleteFile('summary', '摘要/第2章 灯塔.md');
		assert.equal(lib.companionOf('summary', '正文/第2章 灯塔.md'), undefined);
	});

	test('chapters in volume folders, outlines and summaries kept flat (the 0.1.0 layout)', () => {
		const lib = new Library();
		lib.addFile('chapter', '正文/卷二/第31章.md');
		lib.addFile('outline', '大纲/第31章.md');
		lib.addFile('summary', '摘要/第31章.md');
		lib.addFile('outline', '大纲/卷二/第31章.txt');
		assert.equal(lib.companionOf('summary', '正文/卷二/第31章.md'), '摘要/第31章.md');
		assert.equal(lib.companionOf('outline', '正文/卷二/第31章.md'), '大纲/卷二/第31章.txt', 'the one in the matching folder wins');
	});
});

describe('globRootDepth', () => {
	test('counts the fixed folders a glob starts with', () => {
		assert.equal(globRootDepth('{正文,章节,chapters,manuscript}/**/*.{md,txt}'), 1);
		assert.equal(globRootDepth('稿子/正文/**/*.md'), 2);
		assert.equal(globRootDepth('正文/*.md'), 1);
		assert.equal(globRootDepth('**/*.md'), 0);
		assert.equal(globRootDepth('*.md'), 0);
		assert.equal(globRootDepth('正文/第1章.md'), 1);
	});
});

function layout(
	files: { chapters?: string[]; outlines?: string[]; summaries?: string[] },
	bookNames?: string[],
	rootDepth = 1,
): Library {
	const lib = new Library(bookNames);
	files.chapters?.forEach((p) => lib.addFile('chapter', p, rootDepth));
	files.outlines?.forEach((p) => lib.addFile('outline', p, rootDepth));
	files.summaries?.forEach((p) => lib.addFile('summary', p, rootDepth));
	return lib;
}

describe('Library: levels above a chapter', () => {
	test('chapters right in the chapters folder: the book alone', () => {
		const lib = layout({ chapters: ['正文/第1章.md'], outlines: ['大纲/全书.md', '大纲/第1章.md'] });
		assert.deepEqual(lib.levelsOf('正文/第1章.md'), [{ path: '', name: '全书', outline: '大纲/全书.md', summary: undefined }]);
		assert.equal(lib.companionOf('outline', '正文/第1章.md'), '大纲/第1章.md');
	});

	test('any number of folder levels, each with the outline named after its folder', () => {
		const chapter = '正文/第一卷 雾港/第一幕 来信/第1章.md';
		const lib = layout({
			chapters: [chapter],
			outlines: ['大纲/总纲.md', '大纲/第一卷 雾港.md', '大纲/第一卷 雾港/第一幕 来信.md', '大纲/第一卷 雾港/第一幕 来信/第1章.md'],
			summaries: ['摘要/第一卷 雾港.md'],
		});
		assert.deepEqual(lib.levelsOf(chapter), [
			{ path: '', name: '总纲', outline: '大纲/总纲.md', summary: undefined },
			{ path: '正文/第一卷 雾港', name: '第一卷 雾港', outline: '大纲/第一卷 雾港.md', summary: '摘要/第一卷 雾港.md' },
			{ path: '正文/第一卷 雾港/第一幕 来信', name: '第一幕 来信', outline: '大纲/第一卷 雾港/第一幕 来信.md', summary: undefined },
		]);
		assert.equal(lib.companionOf('outline', chapter), '大纲/第一卷 雾港/第一幕 来信/第1章.md');
	});

	test('a level without an outline; same-named levels in different volumes told apart by folder', () => {
		const lib = layout({
			chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md', '正文/卷三/第20章.md'],
			outlines: ['大纲/卷一/第一幕.md', '大纲/卷二/第一幕.md', '大纲/卷二.md'],
		});
		const outlines = (p: string) => lib.levelsOf(p).map((l) => [l.name, l.outline]);
		assert.deepEqual(outlines('正文/卷二/第一幕/第9章.md'), [['全书', undefined], ['卷二', '大纲/卷二.md'], ['第一幕', '大纲/卷二/第一幕.md']]);
		assert.deepEqual(outlines('正文/卷一/第一幕/第1章.md'), [['全书', undefined], ['卷一', undefined], ['第一幕', '大纲/卷一/第一幕.md']]);
		assert.deepEqual(outlines('正文/卷三/第20章.md'), [['全书', undefined], ['卷三', undefined]]);
	});

	test('a level never takes the outline of a same-named level elsewhere; a flat one serves any', () => {
		const lib = layout({
			chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md', '正文/卷二/第二幕/第12章.md'],
			outlines: ['大纲/卷一/第一幕.md', '大纲/第二幕.md'],
		});
		const outlines = (p: string) => lib.levelsOf(p).map((l) => l.outline);
		assert.deepEqual(outlines('正文/卷二/第一幕/第9章.md'), [undefined, undefined, undefined]);
		assert.deepEqual(outlines('正文/卷二/第二幕/第12章.md'), [undefined, undefined, '大纲/第二幕.md']);
	});

	test('four levels deep; chapters, outlines and summaries rooted two folders down', () => {
		const chapter = '稿子/正文/第一部/第一卷/第一幕/第一节/第1章.md';
		const lib = layout(
			{
				chapters: [chapter],
				outlines: ['稿子/大纲/全书.md', '稿子/大纲/第一部.md', '稿子/大纲/第一部/第一卷/第一幕/第一节.md', '稿子/大纲/第一部/全书.md'],
				summaries: ['稿子/摘要/第一部/第一卷.md'],
			},
			undefined,
			2,
		);
		assert.deepEqual(lib.levelsOf(chapter), [
			{ path: '', name: '全书', outline: '稿子/大纲/全书.md', summary: undefined },
			{ path: '稿子/正文/第一部', name: '第一部', outline: '稿子/大纲/第一部.md', summary: undefined },
			{ path: '稿子/正文/第一部/第一卷', name: '第一卷', outline: undefined, summary: '稿子/摘要/第一部/第一卷.md' },
			{ path: '稿子/正文/第一部/第一卷/第一幕', name: '第一幕', outline: undefined, summary: undefined },
			{ path: '稿子/正文/第一部/第一卷/第一幕/第一节', name: '第一节', outline: '稿子/大纲/第一部/第一卷/第一幕/第一节.md', summary: undefined },
		]);
	});

	test('dots in folder names; book names from the settings, only right in the outline folder; other files get the book alone', () => {
		const lib = layout(
			{ chapters: ['manuscript/Vol.2/Ch 1.md'], outlines: ['outline/Vol.2.md', 'outline/drafts/book.md', 'outline/book.md'] },
			['book'],
		);
		assert.deepEqual(lib.levelsOf('manuscript/Vol.2/Ch 1.md').map((l) => [l.name, l.outline]), [
			['book', 'outline/book.md'],
			['Vol.2', 'outline/Vol.2.md'],
		]);
		assert.deepEqual(lib.levelsOf('lore/people/Ann.md').map((l) => l.path), ['']);
	});
});

describe('Library: tree', () => {
	test('levels and chapters in reading order, each with its outline and summary', () => {
		const lib = layout({
			chapters: ['正文/第二卷/第10章.md', '正文/第一卷/第一幕/第2章.md', '正文/第一卷/第一幕/第1章.md', '正文/序章.md'],
			outlines: ['大纲/全书.md', '大纲/第一卷.md', '大纲/第1章.md'],
			summaries: ['摘要/第一卷.md', '摘要/第1章.md'],
		});
		const shape = (n: BookNode): unknown[] => [`${n.kind} ${n.name} ${n.outline ?? '-'} ${n.summary ?? '-'}`, ...n.children.map(shape)];
		assert.deepEqual(shape(lib.tree()), [
			'book 全书 大纲/全书.md -',
			['chapter 序章 - -'],
			[
				'level 第一卷 大纲/第一卷.md 摘要/第一卷.md',
				['level 第一幕 - -', ['chapter 第1章 大纲/第1章.md 摘要/第1章.md'], ['chapter 第2章 - -']],
			],
			['level 第二卷 - -', ['chapter 第10章 - -']],
		]);
	});
});
