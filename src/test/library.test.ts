import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Library, parseLoreEntry } from '../core/library';

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

	test('outline and summary files pair with chapters by name, best directory match first', () => {
		const lib = new Library();
		lib.addFile('outline', '大纲/卷一/第1章.md');
		lib.addFile('outline', '大纲/卷二/第1章.md');
		lib.addFile('summary', '摘要/第2章 灯塔.md');
		assert.equal(lib.companionOf('outline', '正文/卷二/第1章.md'), '大纲/卷二/第1章.md');
		assert.equal(lib.companionOf('outline', '正文/卷一/第1章.txt'), '大纲/卷一/第1章.md');
		assert.equal(lib.companionOf('summary', '正文/第2章 灯塔.md'), '摘要/第2章 灯塔.md');
		assert.equal(lib.companionOf('summary', '正文/第3章.md'), undefined);
		lib.deleteFile('summary', '摘要/第2章 灯塔.md');
		assert.equal(lib.companionOf('summary', '正文/第2章 灯塔.md'), undefined);
	});
});
