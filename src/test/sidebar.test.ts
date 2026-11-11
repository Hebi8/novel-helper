// The pure parts of the sidebar: where renames reach, names for new chapters
// and volumes, lore groups and templates, the starter workspace.

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nameProblem, suggestChapterName, suggestLevelName } from '../core/book';
import { type BookNode, globFolders, Library, parseLoreEntry } from '../core/library';
import { builtinTemplate, fillTemplate, folderForNew, groupLore, groupOf, parseAliases } from '../core/loreGroups';
import type { Translate } from '../core/report';
import { scaffold } from '../core/scaffold';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));

function layout(files: { chapters?: string[]; outlines?: string[]; summaries?: string[] }, rootDepth = 1): Library {
	const lib = new Library();
	files.chapters?.forEach((p) => lib.addFile('chapter', p, rootDepth));
	files.outlines?.forEach((p) => lib.addFile('outline', p, rootDepth));
	files.summaries?.forEach((p) => lib.addFile('summary', p, rootDepth));
	return lib;
}

function find(node: BookNode, name: string): BookNode {
	const found = [node, ...node.children.map((child) => find(child, name))].find((n) => n?.name === name);
	return found as BookNode;
}

const BOOK = {
	chapters: [
		'正文/第一卷 雾港/第一幕 来信/第1章 雾里来信.md',
		'正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md',
		'正文/第一卷 雾港/第二幕 潮声/第3章 钟.md',
		'正文/第二卷 远航/第4章 启程.md',
	],
	outlines: [
		'大纲/全书.md',
		'大纲/第一卷 雾港.md',
		'大纲/第一卷 雾港/第一幕 来信.md',
		'大纲/第一卷 雾港/第一幕 来信/第1章 雾里来信.md',
		'大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.txt',
		'大纲/第二卷 远航/第4章 启程.md',
	],
	summaries: ['摘要/第1章 雾里来信.md', '摘要/第一卷 雾港.md', '摘要/第一卷 雾港/第一幕 来信/第2章 灯塔.md'],
};

describe('globFolders', () => {
	test('one folder per alternative of the leading braces', () => {
		assert.deepEqual(globFolders('{正文,章节,chapters}/**/*.{md,txt}'), ['正文', '章节', 'chapters']);
		assert.deepEqual(globFolders('稿子/{正文,番外}/**/*.md'), ['稿子/正文', '稿子/番外']);
		assert.deepEqual(globFolders('正文/*.md'), ['正文']);
		assert.deepEqual(globFolders('**/*.md'), ['']);
		assert.deepEqual(globFolders('*.md'), ['']);
	});
});

describe('Library: tree nodes, roots', () => {
	test('each node knows the levels it is in', () => {
		const tree = layout(BOOK).tree();
		assert.deepEqual(tree.dirs, []);
		assert.deepEqual(find(tree, '第一卷 雾港').dirs, []);
		assert.deepEqual(find(tree, '第二幕 潮声').dirs, ['第一卷 雾港']);
		assert.deepEqual(find(tree, '第3章 钟').dirs, ['第一卷 雾港', '第二幕 潮声']);
	});

	test('roots: the folders in use, the busiest first', () => {
		const lib = layout({ chapters: ['章节/第1章.md', '正文/卷一/第2章.md', '正文/卷一/第3章.md'], outlines: ['大纲/卷一/第2章.md'] });
		assert.deepEqual(lib.roots('chapter'), ['正文', '章节']);
		assert.deepEqual(lib.roots('outline'), ['大纲']);
		assert.deepEqual(lib.roots('summary'), []);
		assert.deepEqual(layout({ chapters: ['第1章.md', '卷一/第2章.md'] }, 0).roots('chapter'), ['']);
	});
});

describe('Library: renames', () => {
	test('a chapter takes its outline and summary along, each keeping its extension', () => {
		const lib = layout(BOOK);
		assert.deepEqual(lib.renames(find(lib.tree(), '第2章 灯塔'), '第2章 北角灯塔'), [
			{ from: '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md', to: '正文/第一卷 雾港/第一幕 来信/第2章 北角灯塔.md' },
			{ from: '大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.txt', to: '大纲/第一卷 雾港/第一幕 来信/第2章 北角灯塔.txt' },
			{ from: '摘要/第一卷 雾港/第一幕 来信/第2章 灯塔.md', to: '摘要/第一卷 雾港/第一幕 来信/第2章 北角灯塔.md' },
		]);
		assert.deepEqual(lib.renames(find(lib.tree(), '第3章 钟'), '第3章 潮汐钟'), [
			{ from: '正文/第一卷 雾港/第二幕 潮声/第3章 钟.md', to: '正文/第一卷 雾港/第二幕 潮声/第3章 潮汐钟.md' },
		]);
		const dotted = layout({ chapters: ['正文/第1章 v1.0 初稿.md'], outlines: ['大纲/第1章 v1.0 初稿.md'] });
		assert.deepEqual(dotted.renames(find(dotted.tree(), '第1章 v1.0 初稿'), '第1章 v2.0'), [
			{ from: '正文/第1章 v1.0 初稿.md', to: '正文/第1章 v2.0.md' },
			{ from: '大纲/第1章 v1.0 初稿.md', to: '大纲/第1章 v2.0.md' },
		]);
	});

	test('a volume: its folder, the outline and summary named after it, and the folders that mirror it', () => {
		const lib = layout(BOOK);
		assert.deepEqual(lib.renames(find(lib.tree(), '第一卷 雾港'), '第一卷 雾港旧事'), [
			{ from: '正文/第一卷 雾港', to: '正文/第一卷 雾港旧事' },
			{ from: '大纲/第一卷 雾港', to: '大纲/第一卷 雾港旧事' },
			{ from: '摘要/第一卷 雾港', to: '摘要/第一卷 雾港旧事' },
			{ from: '大纲/第一卷 雾港.md', to: '大纲/第一卷 雾港旧事.md' },
			{ from: '摘要/第一卷 雾港.md', to: '摘要/第一卷 雾港旧事.md' },
		]);
	});

	test('a level inside a volume; one with nothing to take along', () => {
		const lib = layout(BOOK);
		assert.deepEqual(lib.renames(find(lib.tree(), '第一幕 来信'), '序幕'), [
			{ from: '正文/第一卷 雾港/第一幕 来信', to: '正文/第一卷 雾港/序幕' },
			{ from: '大纲/第一卷 雾港/第一幕 来信', to: '大纲/第一卷 雾港/序幕' },
			{ from: '摘要/第一卷 雾港/第一幕 来信', to: '摘要/第一卷 雾港/序幕' },
			{ from: '大纲/第一卷 雾港/第一幕 来信.md', to: '大纲/第一卷 雾港/序幕.md' },
		]);
		assert.deepEqual(lib.renames(find(lib.tree(), '第二幕 潮声'), '终幕'), [
			{ from: '正文/第一卷 雾港/第二幕 潮声', to: '正文/第一卷 雾港/终幕' },
		]);
	});

	test('mirror folders that skip the levels above move too, also one that a same-named level elsewhere shares', () => {
		const lib = layout({
			chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md'],
			outlines: ['大纲/第一幕/第1章.md', '大纲/卷二/第一幕/第9章.md', '大纲/卷二/第一幕.md'],
		});
		const [first, second] = lib.tree().children.map((volume) => volume.children[0]);
		assert.deepEqual(lib.renames(first, '序幕'), [
			{ from: '正文/卷一/第一幕', to: '正文/卷一/序幕' },
			{ from: '大纲/第一幕', to: '大纲/序幕' },
		]);
		assert.deepEqual(lib.renames(second, '终幕'), [
			{ from: '正文/卷二/第一幕', to: '正文/卷二/终幕' },
			{ from: '大纲/第一幕', to: '大纲/终幕' },
			{ from: '大纲/卷二/第一幕', to: '大纲/卷二/终幕' },
			{ from: '大纲/卷二/第一幕.md', to: '大纲/卷二/终幕.md' },
		]);
	});

	test('after the renames the tree shows the same outlines and summaries under the new name', () => {
		const lib = layout(BOOK);
		const moves = lib.renames(find(lib.tree(), '第一卷 雾港'), '卷一');
		const move = (path: string) => {
			const hit = moves.find(({ from }) => path === from || path.startsWith(`${from}/`));
			return hit ? hit.to + path.slice(hit.from.length) : path;
		};
		const after = layout({ chapters: BOOK.chapters.map(move), outlines: BOOK.outlines.map(move), summaries: BOOK.summaries.map(move) });
		const marks = (node: BookNode): unknown[] => [`${node.name} ${node.outline ? 'o' : '-'}${node.summary ? 's' : '-'}`, ...node.children.map(marks)];
		const rename = (shape: unknown): unknown =>
			Array.isArray(shape) ? shape.map(rename) : String(shape).replace('第一卷 雾港', '卷一');
		assert.deepEqual(marks(after.tree()), rename(marks(lib.tree())));
		assert.equal(find(after.tree(), '卷一').outline, '大纲/卷一.md');
		assert.equal(find(after.tree(), '第2章 灯塔').summary, '摘要/卷一/第一幕 来信/第2章 灯塔.md');
	});
});

describe('names for new chapters and levels', () => {
	const tree = layout(BOOK).tree();

	test('a new chapter continues its level; an empty book starts at the name given', () => {
		assert.equal(suggestChapterName(tree, tree, '第1章 '), '第5章 ');
		assert.equal(suggestChapterName(tree, find(tree, '第一幕 来信'), '第1章 '), '第3章 ');
		assert.equal(suggestChapterName(tree, find(tree, '第一卷 雾港'), '第1章 '), '第4章 ');
		const empty = new Library().tree();
		assert.equal(suggestChapterName(empty, empty, '第1章 '), '第1章 ');
	});

	test('a level with no numbered chapter of its own goes on from the book', () => {
		const lib = layout({ chapters: ['正文/第一卷/第十一章 雾.md', '正文/第一卷/番外 三哥.md', '正文/第二卷/楔子.md'] });
		const book = lib.tree();
		assert.equal(suggestChapterName(book, find(book, '第一卷'), 'x'), '第十二章 ');
		assert.equal(suggestChapterName(book, find(book, '第二卷'), 'x'), '第十二章 ');
	});

	test('a new level continues its siblings, or starts the pattern used that deep elsewhere', () => {
		assert.equal(suggestLevelName(tree, tree, '第一卷 '), '第三卷 ');
		assert.equal(suggestLevelName(tree, find(tree, '第一卷 雾港'), '第一卷 '), '第三幕 ');
		assert.equal(suggestLevelName(tree, find(tree, '第二卷 远航'), '第一卷 '), '第一幕 ');
		assert.equal(suggestLevelName(tree, find(tree, '第二幕 潮声'), '第一卷 '), '第一卷 ');
		const flat = layout({ chapters: ['正文/第1章.md'] }).tree();
		assert.equal(suggestLevelName(flat, flat, '第一卷 '), '第一卷 ');
	});

	test('names that cannot be used', () => {
		assert.equal(nameProblem('  ', []), 'empty');
		assert.equal(nameProblem('..', []), 'empty');
		assert.equal(nameProblem('第一卷/雾', []), 'separator');
		assert.equal(nameProblem('第1章 ', ['第1章', '第2章']), 'taken');
		assert.equal(nameProblem('第3章 钟？', ['第1章']), undefined);
	});
});

describe('lore groups', () => {
	const entries = [
		parseLoreEntry('人物/林小满.md', '---\naliases: [小满]\n---\n送信员。'),
		parseLoreEntry('人物/潮汐钟.md', '---\ntype: 物件\n---\n一座钟。'),
		parseLoreEntry('设定/北角灯塔.md', '---\ntype: 地点\n---\n灯塔。'),
		parseLoreEntry('设定/地点/雾港.md', '---\ntype: 地点\n---\n港。'),
		parseLoreEntry('设定/地点/旧码头.md', '---\ntype: 地点\n---\n码头。'),
		parseLoreEntry('设定/文风.md', '---\nalways: true\n---\n短句。'),
	];

	test('by type, else by the first folder; in the order given', () => {
		assert.deepEqual(groupLore(entries).map((g) => [g.type, g.entries.map((e) => e.name)]), [
			['人物', ['林小满']],
			['物件', ['潮汐钟']],
			['地点', ['北角灯塔', '雾港', '旧码头']],
			['设定', ['文风']],
		]);
		assert.equal(groupOf(parseLoreEntry('雾港.md', '港。')), '');
	});

	test('aliases as typed', () => {
		assert.deepEqual(parseAliases('小满， 林姑娘、满丫头,小满;'), ['小满', '林姑娘', '满丫头']);
		assert.deepEqual(parseAliases('  '), []);
	});

	test('a new entry goes where its type lives', () => {
		const folders = ['设定', '人物', '资料', 'lore'];
		assert.equal(folderForNew('地点', entries, folders), '设定/地点');
		assert.equal(folderForNew('人物', entries, folders), '人物');
		assert.equal(folderForNew('资料', entries, folders), '资料', 'a new type with a lore folder of its name');
		assert.equal(folderForNew('势力', entries, folders), '设定', 'else the first lore folder that has entries');
		assert.equal(folderForNew('势力', entries, ['lore', '人物', '设定']), '人物');
		assert.equal(folderForNew('势力', [], folders), '设定');
		assert.equal(folderForNew('势力', [], ['']), '');
	});

	test('built-in templates: the type, frontmatter to fill in and a few headings', () => {
		assert.equal(builtinTemplate('人物', t), '---\ntype: 人物\naliases: []\nsummary:\n---\n\n## Appearance\n\n## Personality\n\n## Background\n');
		assert.match(builtinTemplate('Characters', t), /^---\ntype: Characters\n[^]*## Appearance/);
		assert.match(builtinTemplate('地点', t), /## Who is there/);
		assert.match(builtinTemplate('功法', t), /^---\ntype: 功法\naliases: \[\]\nsummary:\n---\n\n## Overview\n\n## Details\n$/);
		const odd = builtinTemplate('人物: 主角 #1', t);
		assert.equal(parseLoreEntry('设定/x.md', odd).type, '人物: 主角 #1', 'quoted where YAML needs it');
	});

	test('a template of the workspace: placeholders filled, the type added when the entry would be listed elsewhere', () => {
		assert.equal(fillTemplate('# {{name}}（{{type}}）\n', '设定/雾.md', '雾', '天气'), '---\ntype: 天气\n---\n# 雾（天气）\n');
		assert.equal(fillTemplate('---\ntype: {{type}}\n---\n# {{name}}\n', '设定/雾.md', '雾', '天气'), '---\ntype: 天气\n---\n# 雾\n');
		// In a folder named after the type, the folder already says it.
		assert.equal(fillTemplate('---\naliases: []\n---\n# {{name}}\n', '人物/陆青.md', '陆青', '人物'), '---\naliases: []\n---\n# 陆青\n');
		assert.equal(groupOf(parseLoreEntry('设定/潮汐会.md', fillTemplate(builtinTemplate('势力', t), '设定/潮汐会.md', '潮汐会', '势力'))), '势力');
	});
});

describe('scaffold', () => {
	const folders = {
		chapters: ['正文', '章节'],
		outlines: ['大纲', '细纲'],
		summaries: ['摘要'],
		lore: ['设定', '人物', '角色', '资料', 'lore'],
	};

	test('the first folder of each setting, 人物 and 资料, the book outline, a style entry, a first volume', () => {
		const items = scaffold(folders, '全书', t);
		assert.deepEqual(items.map((item) => [item.path, item.content === undefined ? 'folder' : 'file', item.firstVolume ?? false]), [
			['正文', 'folder', false],
			['大纲', 'folder', false],
			['摘要', 'folder', false],
			['设定', 'folder', false],
			['人物', 'folder', false],
			['资料', 'folder', false],
			['大纲/全书.md', 'file', false],
			['设定/Style.md', 'file', false],
			['正文/Volume 1/Chapter 1.md', 'file', true],
			['大纲/Volume 1.md', 'file', true],
		]);
		assert.ok(items.every((item) => item.about));
	});

	test('what it makes is read back as a book outline, an always-on entry, and a volume with its outline', () => {
		const items = scaffold(folders, '全书', t);
		const lib = new Library();
		for (const item of items.filter((i) => i.content !== undefined)) {
			const kind = item.path.startsWith('正文/') ? 'chapter' : item.path.startsWith('大纲/') ? 'outline' : undefined;
			if (kind) {
				lib.addFile(kind, item.path);
			} else {
				lib.setLore(item.path, item.content!);
			}
		}
		const style = lib.entries()[0];
		assert.deepEqual([style.name, style.type, style.always, style.error], ['Style', 'Style', true, undefined]);
		const tree = lib.tree();
		assert.equal(tree.outline, '大纲/全书.md');
		assert.deepEqual(tree.children.map((v) => [v.name, v.outline, v.children.map((c) => c.name)]), [['Volume 1', '大纲/Volume 1.md', ['Chapter 1']]]);
	});

	test('settings with other folders; files rooted in the workspace folder itself', () => {
		const custom = scaffold({ chapters: ['manuscript'], outlines: ['outline'], summaries: ['summary'], lore: ['lore'] }, 'book', t);
		assert.deepEqual(custom.filter((i) => i.content === undefined).map((i) => i.path), ['manuscript', 'outline', 'summary', 'lore']);
		assert.ok(custom.some((i) => i.path === 'outline/book.md'));
		const rootless = scaffold({ chapters: [''], outlines: ['大纲'], summaries: [], lore: ['设定'] }, '全书', t);
		assert.deepEqual(rootless.filter((i) => i.content === undefined).map((i) => i.path), ['大纲', '设定']);
		assert.ok(rootless.some((i) => i.path === 'Volume 1/Chapter 1.md'));
	});
});
