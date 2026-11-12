import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ancestors, buildOutline, firstLeaf, type OutlineFile, type OutlineGraph, type OutlineNode, trail, waysFrom } from '../core/outline';

/** Outline files under 大纲: path below it → content. */
function graph(files: Record<string, string>, book: string | undefined = '大纲/全书.md'): OutlineGraph {
	const list: OutlineFile[] = Object.entries(files).map(([below, content]) => ({
		path: `大纲/${below}`,
		dirs: below.split('/').slice(0, -1),
		content,
	}));
	return buildOutline(list, { file: list.some((file) => file.path === book) ? book : undefined, name: '全书' });
}

/** The tree as indented titles. */
function shape(node: OutlineNode, depth = 0): string[] {
	return [`${'  '.repeat(depth)}${node.title}`, ...node.children.flatMap((child) => shape(child, depth + 1))];
}

const titles = (nodes: readonly OutlineNode[]) => nodes.map((node) => node.title);

const BOOK = graph({
	'全书.md': '# 全书大纲\n\n一句话：雾港来信。',
	'第一卷.md': '第一卷的概述',
	'第一卷/第10章.md': '## 出海\n\n夜里出海。\n\n## 靠岸\n',
	'第一卷/第2章.md': '---\ntitle: 灯塔\n---\n# 第2章 灯塔\n\n这一章的概述。\n\n## 等门\n\n等到傍晚。\n\n### 潮汐钟\n\n钟响了。\n\n## 收信\n\n周伯收下信。\n→ 出海\n',
	'第二卷/第11章.md': '没有标题的一章',
});

describe('the outline as a tree', () => {
	test('folders, files and headings nest; a file and the folder of its name are one node; files in natural order, headings as written', () => {
		assert.deepEqual(shape(BOOK.root), [
			'全书',
			'  第一卷',
			'    第2章',
			'      等门',
			'        潮汐钟',
			'      收信',
			'    第10章',
			'      出海',
			'      靠岸',
			'  第二卷',
			'    第11章',
		]);
		assert.deepEqual([...BOOK.nodes.values()].map((node) => [node.kind, node.id]), [
			['book', '大纲/全书.md'],
			['file', '大纲/第一卷.md'],
			['file', '大纲/第一卷/第2章.md'],
			['heading', '大纲/第一卷/第2章.md#等门'],
			['heading', '大纲/第一卷/第2章.md#等门/潮汐钟'],
			['heading', '大纲/第一卷/第2章.md#收信'],
			['file', '大纲/第一卷/第10章.md'],
			['heading', '大纲/第一卷/第10章.md#出海'],
			['heading', '大纲/第一卷/第10章.md#靠岸'],
			['folder', '大纲/第二卷/'],
			['file', '大纲/第二卷/第11章.md'],
		]);
	});

	test('a node has the text right under it; a single # title at the top is the file\'s own; lines count from the top of the file', () => {
		const node = (id: string) => BOOK.nodes.get(id)!;
		assert.equal(BOOK.root.text, '一句话：雾港来信。');
		assert.equal(node('大纲/第一卷.md').text, '第一卷的概述');
		assert.equal(node('大纲/第一卷/第2章.md').text, '这一章的概述。');
		assert.equal(node('大纲/第一卷/第2章.md#等门').text, '等到傍晚。');
		assert.equal(node('大纲/第一卷/第2章.md#收信').text, '周伯收下信。', 'the → line is not part of the text');
		assert.deepEqual([node('大纲/第一卷/第2章.md').line, node('大纲/第一卷/第2章.md#等门').line, node('大纲/第一卷/第2章.md#等门/潮汐钟').line], [0, 7, 11]);
		assert.equal(node('大纲/第二卷/').file, undefined);
	});

	test('headings in code fences are not headings; two # titles are both nodes; same-named siblings get ids of their own', () => {
		const one = graph({ '甲.md': '# 上\n\n```\n# 不是标题\n```\n\n# 下\n\n## 段\n\n## 段\n' }, undefined);
		assert.deepEqual(shape(one.root), ['全书', '  甲', '    上', '    下', '      段', '      段']);
		assert.deepEqual([...one.nodes.keys()].slice(-2), ['大纲/甲.md#下/段', '大纲/甲.md#下/段 (2)']);
		assert.equal(one.nodes.get('大纲/甲.md#上')!.text, '```\n# 不是标题\n```');
	});

	test('the leaves in order are the main line; nothing written, no main line', () => {
		assert.deepEqual(titles(BOOK.leaves), ['潮汐钟', '收信', '出海', '靠岸', '第11章']);
		assert.deepEqual(graph({}).leaves, []);
		assert.deepEqual(titles(graph({ '全书.md': '只有全书大纲' }).leaves), ['全书']);
		assert.equal(firstLeaf(BOOK.nodes.get('大纲/第一卷.md')!).title, '潮汐钟');
		assert.deepEqual(titles(ancestors(BOOK.nodes.get('大纲/第一卷/第2章.md#等门/潮汐钟')!)), ['全书', '第一卷', '第2章', '等门']);
		assert.equal(trail(BOOK.nodes.get('大纲/第一卷/第2章.md#等门/潮汐钟')!), '第一卷 › 第2章 › 等门 › 潮汐钟');
	});

	test('several outline folders: each one\'s files come under the book, folder by folder', () => {
		const two = buildOutline(
			[
				{ path: '细纲/第1章.md', dirs: [], content: '' },
				{ path: '大纲/全书.md', dirs: [], content: '## 主线\n' },
				{ path: '大纲/第一卷.md', dirs: [], content: '' },
			],
			{ file: '大纲/全书.md', name: '全书' },
		);
		assert.deepEqual(shape(two.root), ['全书', '  主线', '  第一卷', '  第1章']);
	});
});

describe('links between nodes', () => {
	const linked = graph({
		'全书.md': '',
		'第一卷.md': '## 来信\n\n→ 点灯\n→ 第二卷/回潮#船回来\n\n## 渡海\n\n→ 出海\n-> 没有的节点\n\n## 点灯\n\n## 出海\n\n→ 第二卷/回潮.md#船回来\n',
		'第二卷/回潮.md': '## 船回来\n\n→ 出海\n→ #灯亮\n\n## 灯亮\n\n## 出海\n\n→ 第二卷/回潮\n→ 第一卷\n',
	});
	const node = (id: string) => linked.nodes.get(id)!;
	const targets = (id: string) => node(id).links.map((link) => link.target?.id ?? link.problem);

	test('by title; by path#title, with or without the extension; #title is in the same file', () => {
		assert.deepEqual(targets('大纲/第一卷.md#来信'), ['大纲/第一卷.md#点灯', '大纲/第二卷/回潮.md#船回来']);
		assert.deepEqual(targets('大纲/第一卷.md#出海'), ['大纲/第二卷/回潮.md#船回来']);
		assert.deepEqual(targets('大纲/第二卷/回潮.md#船回来'), ['大纲/第二卷/回潮.md#出海', '大纲/第二卷/回潮.md#灯亮']);
	});

	test('a title two nodes have means the one in the same file, else it is ambiguous; a title no node has is missing; a path names a file', () => {
		assert.deepEqual(targets('大纲/第一卷.md#渡海'), ['大纲/第一卷.md#出海', 'missing']);
		assert.deepEqual(targets('大纲/第二卷/回潮.md#出海'), ['大纲/第二卷/回潮.md', '大纲/第一卷.md']);
		const twice = graph({ '甲.md': '## 结局\n', '乙.md': '## 结局\n', '丙.md': '→ 结局\n' }, undefined);
		assert.deepEqual(twice.nodes.get('大纲/丙.md')!.links.map((link) => link.problem), ['ambiguous']);
	});

	test('from a leaf: the next leaf, the one before, and where the links lead (a node with children stands for its first leaf)', () => {
		const ways = (id: string) => {
			const { next, previous, linked: to } = waysFrom(linked, node(id));
			return [previous?.title, next?.title, titles(to)];
		};
		assert.deepEqual(titles(linked.leaves), ['来信', '渡海', '点灯', '出海', '船回来', '灯亮', '出海']);
		assert.deepEqual(ways('大纲/第一卷.md#来信'), [undefined, '渡海', ['点灯', '船回来']]);
		assert.deepEqual(ways('大纲/第一卷.md#渡海'), ['来信', '点灯', ['出海']]);
		assert.deepEqual(ways('大纲/第一卷.md#出海'), ['点灯', '船回来', []], 'a link to the next leaf adds nothing');
		assert.deepEqual(ways('大纲/第二卷/回潮.md#出海'), ['灯亮', undefined, ['船回来', '来信']]);
	});

	test('the links of a node with children are ways on from its last leaf', () => {
		const one = graph({ '甲.md': '→ 丙\n\n## 一\n\n## 二\n', '乙.md': '', '丙.md': '' }, undefined);
		assert.deepEqual(titles(waysFrom(one, one.nodes.get('大纲/甲.md#二')!).linked), ['丙']);
		assert.deepEqual(titles(waysFrom(one, one.nodes.get('大纲/甲.md#一')!).linked), []);
	});
});
