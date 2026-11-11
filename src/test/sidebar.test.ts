// The pure parts of the sidebar: where renames reach, names for new chapters
// and volumes, lore groups and templates, the starter workspace.

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nameProblem, suggestChapterName, suggestLevelName } from '../core/book';
import { type BookNode, globFolders, Library, parseLoreEntry } from '../core/library';
import { builtinTemplate, fillTemplate, folderForNew, groupLore, groupOf, parseAliases, templateNames } from '../core/loreGroups';
import type { Translate } from '../core/report';
import { leadsOut } from '../core/story';
import { firstNames, markerOf, scaffold, storyNames } from '../core/scaffold';

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
	const moves = (lib: Library, name: string, newName: string) => lib.renames(find(lib.tree(), name), newName).renames;

	test('a chapter takes its outline and summary along, each keeping its extension', () => {
		const lib = layout(BOOK);
		assert.deepEqual(moves(lib, '第2章 灯塔', '第2章 北角灯塔'), [
			{ from: '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md', to: '正文/第一卷 雾港/第一幕 来信/第2章 北角灯塔.md' },
			{ from: '大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.txt', to: '大纲/第一卷 雾港/第一幕 来信/第2章 北角灯塔.txt' },
			{ from: '摘要/第一卷 雾港/第一幕 来信/第2章 灯塔.md', to: '摘要/第一卷 雾港/第一幕 来信/第2章 北角灯塔.md' },
		]);
		assert.deepEqual(moves(lib, '第3章 钟', '第3章 潮汐钟'), [
			{ from: '正文/第一卷 雾港/第二幕 潮声/第3章 钟.md', to: '正文/第一卷 雾港/第二幕 潮声/第3章 潮汐钟.md' },
		]);
		const dotted = layout({ chapters: ['正文/第1章 v1.0 初稿.md'], outlines: ['大纲/第1章 v1.0 初稿.md'] });
		assert.deepEqual(moves(dotted, '第1章 v1.0 初稿', '第1章 v2.0'), [
			{ from: '正文/第1章 v1.0 初稿.md', to: '正文/第1章 v2.0.md' },
			{ from: '大纲/第1章 v1.0 初稿.md', to: '大纲/第1章 v2.0.md' },
		]);
	});

	test('a volume: its folder, the outline and summary named after it, and the folders that stand for it', () => {
		const lib = layout(BOOK);
		assert.deepEqual(moves(lib, '第一卷 雾港', '第一卷 雾港旧事'), [
			{ from: '正文/第一卷 雾港', to: '正文/第一卷 雾港旧事' },
			{ from: '大纲/第一卷 雾港', to: '大纲/第一卷 雾港旧事' },
			{ from: '摘要/第一卷 雾港', to: '摘要/第一卷 雾港旧事' },
			{ from: '大纲/第一卷 雾港.md', to: '大纲/第一卷 雾港旧事.md' },
			{ from: '摘要/第一卷 雾港.md', to: '摘要/第一卷 雾港旧事.md' },
		]);
	});

	test('a level inside a volume; one with nothing to take along', () => {
		const lib = layout(BOOK);
		assert.deepEqual(moves(lib, '第一幕 来信', '序幕'), [
			{ from: '正文/第一卷 雾港/第一幕 来信', to: '正文/第一卷 雾港/序幕' },
			{ from: '大纲/第一卷 雾港/第一幕 来信', to: '大纲/第一卷 雾港/序幕' },
			{ from: '摘要/第一卷 雾港/第一幕 来信', to: '摘要/第一卷 雾港/序幕' },
			{ from: '大纲/第一卷 雾港/第一幕 来信.md', to: '大纲/第一卷 雾港/序幕.md' },
		]);
		assert.deepEqual(moves(lib, '第二幕 潮声', '终幕'), [{ from: '正文/第一卷 雾港/第二幕 潮声', to: '正文/第一卷 雾港/终幕' }]);
	});

	test('same-named arcs in two volumes: each takes only the folders that are its own', () => {
		const lib = layout({
			chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md'],
			outlines: ['大纲/第一幕/第1章.md', '大纲/卷二/第一幕/第9章.md', '大纲/卷二/第一幕.md'],
		});
		const [first, second] = lib.tree().children.map((volume) => volume.children[0]);
		// 大纲/第一幕 skips the volume; the only chapter that takes an outline from it is in 卷一.
		assert.deepEqual(lib.renames(first, '序幕').renames, [
			{ from: '正文/卷一/第一幕', to: '正文/卷一/序幕' },
			{ from: '大纲/第一幕', to: '大纲/序幕' },
		]);
		assert.deepEqual(lib.renames(second, '终幕').renames, [
			{ from: '正文/卷二/第一幕', to: '正文/卷二/终幕' },
			{ from: '大纲/卷二/第一幕', to: '大纲/卷二/终幕' },
			{ from: '大纲/卷二/第一幕.md', to: '大纲/卷二/终幕.md' },
		]);
	});

	test('a folder that holds the outlines of two volumes\' same-named arcs: neither arc is renamed', () => {
		const lib = layout({
			chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md'],
			outlines: ['大纲/第一幕/第1章.md', '大纲/第一幕/第9章.md'],
		});
		const [first, second] = lib.tree().children.map((volume) => volume.children[0]);
		const blocked = { path: '大纲/第一幕', sharedBy: ['正文/卷一/第一幕', '正文/卷二/第一幕'] };
		assert.deepEqual(lib.renames(first, '序幕'), { blocked });
		assert.deepEqual(lib.renames(second, '终幕'), { blocked });
		// The volumes themselves share nothing.
		assert.deepEqual(lib.renames(lib.tree().children[0], '第一卷').renames, [{ from: '正文/卷一', to: '正文/第一卷' }]);
	});

	test('a level named like the one it is in: the outer folder stays, no move pulls the ground from under another', () => {
		const lib = layout({ chapters: ['正文/A/A/第1章.md'], outlines: ['大纲/A/A.md', '大纲/A/A/第1章.md'] });
		const outer = lib.tree().children[0];
		assert.deepEqual(lib.renames(outer.children[0], 'B').renames, [
			{ from: '正文/A/A', to: '正文/A/B' },
			{ from: '大纲/A/A', to: '大纲/A/B' },
			{ from: '大纲/A/A.md', to: '大纲/A/B.md' },
		]);
		assert.deepEqual(lib.renames(outer, 'B').renames, [
			{ from: '正文/A', to: '正文/B' },
			{ from: '大纲/A', to: '大纲/B' },
		]);
		const bare = layout({ chapters: ['正文/A/A/第1章.md'], outlines: ['大纲/A/A.md'] });
		assert.deepEqual(bare.renames(bare.tree().children[0].children[0], 'B').renames, [
			{ from: '正文/A/A', to: '正文/A/B' },
			{ from: '大纲/A/A.md', to: '大纲/A/B.md' },
		]);
	});

	test('an outline or summary that two chapters, or two levels, take: neither is renamed', () => {
		const chapters = layout({ chapters: ['正文/卷一/第1章.md', '正文/卷二/第1章.md'], outlines: ['大纲/第1章.md'] });
		const [one, two] = chapters.tree().children.map((volume) => volume.children[0]);
		const blocked = { path: '大纲/第1章.md', sharedBy: ['正文/卷一/第1章.md', '正文/卷二/第1章.md'] };
		assert.deepEqual(chapters.renames(one, '第1章 雾'), { blocked });
		assert.deepEqual(chapters.renames(two, '第1章 雾'), { blocked });
		const levels = layout({ chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md'], summaries: ['摘要/第一幕.md'] });
		assert.deepEqual(levels.renames(levels.tree().children[0].children[0], '序幕'), {
			blocked: { path: '摘要/第一幕.md', sharedBy: ['正文/卷一/第一幕', '正文/卷二/第一幕'] },
		});
	});

	test('outlines written ahead, for chapters that are not there yet, go along when the folder can only be this level\'s', () => {
		const lib = layout({ chapters: ['正文/卷一/第1章.md', '正文/卷二/第一幕/第9章.md'], outlines: ['大纲/卷一/第5章.md', '大纲/第一幕/第12章.md'] });
		assert.deepEqual(moves(lib, '卷一', '第一卷'), [
			{ from: '正文/卷一', to: '正文/第一卷' },
			{ from: '大纲/卷一', to: '大纲/第一卷' },
		]);
		assert.deepEqual(moves(lib, '第一幕', '序幕'), [
			{ from: '正文/卷二/第一幕', to: '正文/卷二/序幕' },
			{ from: '大纲/第一幕', to: '大纲/序幕' },
		]);
		const two = layout({ chapters: ['正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md'], outlines: ['大纲/第一幕/第12章.md'] });
		assert.deepEqual(two.renames(two.tree().children[0].children[0], '序幕').renames, [{ from: '正文/卷一/第一幕', to: '正文/卷一/序幕' }], 'whose it is cannot be told: it stays');
	});

	test('no move is ever from inside a folder that moves too', () => {
		for (const lib of [layout(BOOK), layout({ chapters: ['正文/A/A/A/第1章.md'], outlines: ['大纲/A/A/A.md', '大纲/A/A/A/第1章.md', '大纲/A.md'], summaries: ['摘要/A/第1章.md'] })]) {
			const visit = (node: BookNode) => {
				const plan = node.kind === 'book' ? undefined : lib.renames(node, 'X').renames;
				for (const one of plan ?? []) {
					assert.ok(!plan!.some((other) => one.from.startsWith(`${other.from}/`)), `${one.from} moves on its own and with its folder`);
				}
				node.children.forEach(visit);
			};
			visit(lib.tree());
		}
	});

	test('after the renames the tree shows the same outlines and summaries under the new name', () => {
		const lib = layout(BOOK);
		const plan = moves(lib, '第一卷 雾港', '卷一')!;
		const move = (path: string) => {
			const hit = plan.find(({ from }) => path === from || path.startsWith(`${from}/`));
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

describe('templates of the workspace', () => {
	test('a name is put in as it is: $ means nothing', () => {
		assert.equal(fillTemplate('# {{name}}\n\n{{name}}（{{type}}）\n', '设定/x.md', '$&', '$$'), '---\ntype: $$\n---\n# $&\n\n$&（$$）\n');
		assert.equal(fillTemplate("# {{name}}\n", '人物/x.md', "$`$'$1", '人物'), "# $`$'$1\n");
	});

	test('inside the frontmatter a name is a YAML value, quoted where it has to be', () => {
		const template = '---\nname: {{name}}\ntype: {{type}}\naliases: []\n---\n# {{name}}\n';
		for (const name of ['风: 雨', '[风]', '{雨}', '# 七', '123', 'true', '"引号"', "it's", '林小满']) {
			const entry = parseLoreEntry('设定/x.md', fillTemplate(template, '设定/x.md', name, '天气: 晴'));
			assert.deepEqual([entry.name, entry.type, entry.error, entry.body], [name, '天气: 晴', undefined, `# ${name}`], name);
		}
		assert.equal(fillTemplate(template, '设定/x.md', '林小满', '人物'), '---\nname: 林小满\ntype: 人物\naliases: []\n---\n# 林小满\n');
	});

	test('a template whose frontmatter is not valid once filled in is refused', () => {
		assert.throws(() => fillTemplate('---\nname: "{{name}}"\n---\n', '设定/x.md', '风: 雨', '天气'));
		assert.throws(() => fillTemplate('---\naliases: [未收尾\n---\n# {{name}}\n', '设定/x.md', '雾', '天气'));
	});

	test('a type names a template only when it is a plain file name', () => {
		assert.deepEqual(templateNames('人物'), ['人物', 'default']);
		assert.deepEqual(templateNames('default'), ['default']);
		for (const type of ['../../../private', '..', '.', '', 'a/b', 'a\\b', '/etc/passwd']) {
			assert.deepEqual(templateNames(type), ['default'], type);
		}
	});
});

describe('scaffold', () => {
	const folders = {
		chapters: ['正文', '章节', 'chapters', 'manuscript'],
		outlines: ['大纲', '细纲', 'outline', 'outlines'],
		summaries: ['摘要', 'summary', 'summaries'],
		lore: ['设定', '人物', '角色', '资料', '世界观', 'lore', 'characters', 'worldbuilding'],
	};
	const bookNames = ['全书', '总纲', 'book'];
	const shape = (items: ReturnType<typeof scaffold>) =>
		items.map((item) => `${item.path}${item.content === undefined ? '/' : ''}${item.firstVolume ? ' (first volume)' : ''}`);

	test('Chinese names: 正文, 大纲, 摘要, 设定 with 人物 and 资料, the book outline, a style entry, a first volume', () => {
		const names = storyNames(folders, bookNames, 'zh');
		assert.deepEqual(names, { language: 'zh', chapters: '正文', outlines: '大纲', summaries: '摘要', lore: ['设定', '人物', '资料'], book: '全书' });
		const items = scaffold(names, t);
		assert.deepEqual(shape(items), [
			'正文/',
			'大纲/',
			'摘要/',
			'设定/',
			'人物/',
			'资料/',
			'大纲/全书.md',
			'设定/文风.md',
			'正文/第一卷/第1章.md (first volume)',
			'大纲/第一卷.md (first volume)',
		]);
		assert.ok(items.every((item) => item.about));
		assert.equal(items[6].content, '# 全书大纲\n\n## 一句话\n\n## 主线\n\n## 分卷\n');
		assert.equal(items[7].content, '---\ntype: 文风\nalways: true\n---\n\n## 人称和时态\n\n## 语言\n\n## 不要写的\n');
	});

	test('English names, out of the ones the default settings recognize', () => {
		const names = storyNames(folders, bookNames, 'en');
		assert.deepEqual(names, { language: 'en', chapters: 'chapters', outlines: 'outlines', summaries: 'summaries', lore: ['lore', 'characters', 'worldbuilding'], book: 'book' });
		const items = scaffold(names, t);
		assert.deepEqual(shape(items), [
			'chapters/',
			'outlines/',
			'summaries/',
			'lore/',
			'characters/',
			'worldbuilding/',
			'outlines/book.md',
			'lore/Style.md',
			'chapters/Volume 1/Chapter 1.md (first volume)',
			'outlines/Volume 1.md (first volume)',
		]);
		assert.equal(items[6].content, '# Outline of the whole book\n\n## In one sentence\n\n## Main plot\n\n## Volumes\n');
		assert.match(items[7].content!, /^---\ntype: Style\nalways: true\n---\n\n## Person and tense\n/);
	});

	test('what it makes is read back as a book outline, an always-on entry, and a volume with its outline', () => {
		for (const language of ['zh', 'en'] as const) {
			const names = storyNames(folders, bookNames, language);
			const lib = new Library(bookNames);
			for (const item of scaffold(names, t).filter((i) => i.content !== undefined)) {
				const kind = item.path.startsWith(`${names.chapters}/`) ? 'chapter' : item.path.startsWith(`${names.outlines}/`) ? 'outline' : undefined;
				if (kind) {
					lib.addFile(kind, item.path);
				} else {
					lib.setLore(item.path, item.content!);
				}
			}
			const style = lib.entries()[0];
			assert.deepEqual([style.always, style.error], [true, undefined]);
			const tree = lib.tree();
			assert.equal(tree.outline, `${names.outlines}/${names.book}.md`);
			const { volume, chapter } = firstNames(language);
			assert.deepEqual(tree.children.map((v) => [v.name, v.outline, v.children.map((c) => c.name)]), [[volume, `${names.outlines}/${volume}.md`, [chapter]]]);
		}
	});

	test('settings with other names: the first of the wanted language, else the first', () => {
		const custom = { chapters: ['稿子', 'draft'], outlines: ['plan'], summaries: ['梗概'], lore: ['百科', 'wiki'] };
		assert.deepEqual(storyNames(custom, ['总纲'], 'zh'), { language: 'zh', chapters: '稿子', outlines: 'plan', summaries: '梗概', lore: ['百科'], book: '总纲' });
		assert.deepEqual(storyNames(custom, ['总纲'], 'en'), { language: 'en', chapters: 'draft', outlines: 'plan', summaries: '梗概', lore: ['wiki'], book: '总纲' });
	});

	test('files rooted in the story folder itself have no folder to make', () => {
		const names = storyNames({ chapters: [''], outlines: ['大纲'], summaries: [], lore: ['设定'] }, [], 'zh');
		assert.deepEqual(shape(scaffold(names, t)), ['大纲/', '设定/', '大纲/全书.md', '设定/文风.md', '第一卷/第1章.md (first volume)', '大纲/第一卷.md (first volume)']);
	});

	test('names from settings that would lead out of the story folder can be told', () => {
		const names = storyNames({ chapters: ['正文'], outlines: ['大纲'], summaries: ['摘要'], lore: ['../escaped'] }, ['../../escaped-book'], 'zh');
		assert.deepEqual(scaffold(names, t).map((item) => item.path).filter(leadsOut), ['../escaped', '大纲/../../escaped-book.md', '../escaped/文风.md']);
		assert.deepEqual(scaffold(storyNames(folders, bookNames, 'zh'), t).map((item) => item.path).filter(leadsOut), []);
	});

	test('the marker records the names and nothing else', () => {
		assert.deepEqual(markerOf(storyNames(folders, bookNames, 'en')), {
			version: 1,
			language: 'en',
			folders: { chapters: 'chapters', outlines: 'outlines', summaries: 'summaries', lore: ['lore', 'characters', 'worldbuilding'] },
			book: 'book',
		});
	});
});
