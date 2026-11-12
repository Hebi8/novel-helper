import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	bridgeTo,
	type BuoyState,
	buoyPath,
	choices,
	choose,
	hasOpenMarks,
	initialPosition,
	inNode,
	JUDGE_INSTRUCTIONS,
	judgePrompt,
	locate,
	markAt,
	nextOf,
	parallelWith,
	parseBuoyFile,
	type Position,
	positionSource,
	readJudgement,
	readRelocation,
	RELOCATE_INSTRUCTIONS,
	relocatePrompt,
	renameState,
	resolve,
	serializeBuoyFile,
	stateOf,
	step,
} from '../core/buoy';
import { buildOutline, type OutlineGraph } from '../core/outline';

function graph(files: Record<string, string>): OutlineGraph {
	return buildOutline(
		Object.entries(files).map(([below, content]) => ({ path: `大纲/${below}`, dirs: below.split('/').slice(0, -1), content })),
		{ file: '大纲/全书.md', name: '全书' },
	);
}

const FILES = {
	'全书.md': '全书的概述',
	'第一卷.md': '第一卷的概述',
	'第一卷/第1章.md': '## 来信\n\n信送不出去。\n→ 点灯\n\n## 等门\n\n等到傍晚。\n',
	'第一卷/第2章.md': '## 收信\n\n周伯收下信。\n\n## 渡海\n\n找船。\n\n## 点灯\n\n灯亮了。\n',
};
const G = graph(FILES);
const node = (title: string, g = G) => g.leaves.find((leaf) => leaf.title === title)!;
const at = (title: string): Position => inNode(node(title));
const said = (position: Position | undefined) => position && `${position.kind}: ${position.nodes.map((n) => n.title).join(', ')}`;
const state = (kind: BuoyState['kind'], ...ids: string[]): BuoyState => ({ kind, nodes: ids.map((id) => ({ id, title: id.slice(id.lastIndexOf('#') + 1) })) });

describe('where the buoys are', () => {
	test('a state is found again by node id; a heading moved within its file, by its title; a node given sub-headings stands for its first leaf', () => {
		assert.equal(said(resolve(G, state('bridge', '大纲/第一卷/第1章.md#等门', '大纲/第一卷/第2章.md#收信'))), 'bridge: 等门, 收信');
		const moved = graph({ ...FILES, '第一卷/第1章.md': '## 开头\n\n### 来信\n\n### 插进来的\n\n## 等门\n' });
		assert.equal(said(resolve(moved, state('in', '大纲/第一卷/第1章.md#来信'))), 'in: 来信');
		const split = graph({ ...FILES, '第一卷/第1章.md': '## 来信\n\n### 上\n\n### 下\n\n## 等门\n' });
		assert.equal(said(resolve(split, state('in', '大纲/第一卷/第1章.md#来信'))), 'in: 上');
		assert.equal(said(resolve(G, state('in', '大纲/第一卷/第1章.md'))), 'in: 来信', 'a file: its first leaf');
	});

	test('a node that is gone, or whose title two headings of the file now have: the buoys are lost', () => {
		const renamed = graph({ ...FILES, '第一卷/第1章.md': '## 信来了\n\n## 等门\n' });
		assert.equal(resolve(renamed, state('in', '大纲/第一卷/第1章.md#来信')), undefined);
		assert.equal(resolve(renamed, state('parallel', '大纲/第一卷/第1章.md#等门', '大纲/第一卷/第1章.md#来信')), undefined, 'one of two is enough');
		const twice = graph({ ...FILES, '第一卷/第1章.md': '## 甲\n\n### 来信\n\n## 乙\n\n### 来信\n' });
		assert.equal(resolve(twice, state('in', '大纲/第一卷/第1章.md#来信')), undefined);
		assert.equal(resolve(G, state('in', '大纲/第三卷/第9章.md')), undefined);
	});

	test('two buoys on one node are one buoy', () => {
		assert.equal(said(resolve(G, state('parallel', '大纲/第一卷/第1章.md#来信', '大纲/第一卷/第1章.md#来信'))), 'in: 来信');
		assert.equal(said(bridgeTo(at('来信'), node('来信'))), 'in: 来信');
		assert.equal(said(bridgeTo(at('来信'), node('收信'))), 'bridge: 来信, 收信');
		assert.equal(said(parallelWith(bridgeTo(at('来信'), node('收信')), node('点灯'))), 'parallel: 来信, 点灯', 'the first buoy stays');
		assert.equal(said(bridgeTo(undefined, node('收信'))), 'in: 收信');
	});

	test('a chapter that is starting: where the one before it ended, else the first leaf of the outline file that goes with it', () => {
		const previous = state('bridge', '大纲/第一卷/第1章.md#等门', '大纲/第一卷/第2章.md#收信');
		assert.equal(said(initialPosition(G, previous, '大纲/第一卷/第2章.md')), 'bridge: 等门, 收信');
		assert.equal(said(initialPosition(G, state('in', '大纲/没有了.md#甲'), '大纲/第一卷/第2章.md')), 'in: 收信');
		assert.equal(said(initialPosition(G, undefined, '大纲/第一卷.md')), 'in: 来信', 'a volume\'s outline: its first leaf');
		assert.equal(initialPosition(G, undefined, undefined), undefined);
		assert.equal(initialPosition(G, undefined, '大纲/第一卷/第9章.md'), undefined);
	});

	test('one step along the main line', () => {
		assert.equal(said(step(G, at('等门'), 'forward')), 'in: 收信');
		assert.equal(said(step(G, at('等门'), 'back')), 'in: 来信');
		assert.equal(step(G, at('来信'), 'back'), undefined);
		assert.equal(step(G, at('点灯'), 'forward'), undefined);
		const bridge = bridgeTo(at('来信'), node('点灯'));
		assert.equal(said(step(G, bridge, 'forward')), 'in: 点灯', 'a bridge arrives');
		assert.equal(said(step(G, bridge, 'back')), 'in: 来信');
		const pair = parallelWith(at('收信'), node('等门'));
		assert.equal(said(step(G, pair, 'forward')), 'in: 渡海', 'on from the later of the two');
		assert.equal(said(step(G, pair, 'back')), 'in: 收信');
		assert.equal(nextOf(G, at('等门'))?.title, '收信');
		assert.equal(nextOf(G, bridge), undefined, 'a bridge is heading for its second node already');
	});

	test('what goes into the continuation prompt: the nodes, what the first is under (not the book), the node after', () => {
		assert.deepEqual(positionSource(G, at('等门')), {
			kind: 'in',
			nodes: [{ title: '等门', path: '大纲/第一卷/第1章.md', text: '等到傍晚。' }],
			above: [
				{ title: '第一卷', path: '大纲/第一卷.md', text: '第一卷的概述' },
				{ title: '第1章', path: '大纲/第一卷/第1章.md', text: '' },
			],
			next: { title: '收信', path: '大纲/第一卷/第2章.md', text: '周伯收下信。' },
		});
		const inBook = graph({ '全书.md': '## 主线\n\n### 来信\n\n### 点灯\n' });
		assert.deepEqual(positionSource(inBook, inNode(node('来信', inBook))).above, [], 'headings of the book\'s own outline: it goes in whole anyway');
	});
});

describe('marks', () => {
	test('a mark is put at the end of the text, with the words before it', () => {
		const text = `---\ntitle: x\n---\n${'字'.repeat(40)}`;
		const mark = markAt(text, 40, stateOf(at('等门')), 'manual', new Date('2026-11-12T10:00:00Z'));
		assert.deepEqual(mark, {
			at: text.length,
			before: '字'.repeat(30),
			chars: 40,
			time: '2026-11-12T10:00:00.000Z',
			by: 'manual',
			state: { kind: 'in', nodes: [{ id: '大纲/第一卷/第1章.md#等门', title: '等门' }] },
		});
	});

	test('a mark is found again after the text before it changed', () => {
		const mark = { at: 20, before: '他推开门，走了进去。' };
		const text = `${'前'.repeat(10)}他推开门，走了进去。后面的字`;
		assert.equal(locate(text, mark), 20);
		assert.equal(locate(`新加的一句。${text}`, mark), 26, 'text was added before it');
		assert.equal(locate(text.slice(4), mark), 16, 'text was removed before it');
		assert.equal(locate(`${'前'.repeat(10)}他推开了门。后面的字还有很多很多`, mark), 20, 'the words are gone: the offset stands');
		assert.equal(locate('短了', mark), 2, 'or the end of a text that is shorter now');
		assert.equal(locate(`他推开门，走了进去。${'中'.repeat(30)}他推开门，走了进去。`, { at: 38, before: mark.before }), 50, 'the nearest place that reads the same');
		assert.equal(locate(text, { at: 0, before: '' }), 0);
	});

	test('the file: one per chapter, next to nothing the writer writes; what cannot be read is left out', () => {
		assert.equal(buoyPath('正文/第一卷/第1章.md'), '.novel-helper/buoys/正文/第一卷/第1章.md.json');
		const mark = markAt('正文', 2, stateOf(at('等门')), 'init', new Date(0));
		const file = { version: 1, chapter: '正文/第1章.md', marks: [mark] };
		assert.deepEqual(parseBuoyFile(serializeBuoyFile(file)), file);
		assert.equal(parseBuoyFile('not json'), undefined);
		assert.equal(parseBuoyFile('{"version":1}'), undefined);
		const broken = { ...file, marks: [mark, { ...mark, state: { kind: 'bridge', nodes: mark.state.nodes } }, { at: 'x' }] };
		assert.deepEqual(parseBuoyFile(JSON.stringify(broken))?.marks, [mark], 'a bridge needs two nodes');
	});

	test('a mark that only says where the buoys are, as the assistant adds them, is kept for the extension to fill in', () => {
		const whole = markAt('正文', 2, stateOf(at('等门')), 'init', new Date(0));
		const open = { by: 'assistant', state: stateOf(at('收信')) };
		const written = JSON.stringify({ version: 1, chapter: '正文/第1章.md', marks: [whole, open, { by: 'assistant', state: { kind: 'in', nodes: [] } }] });
		assert.equal(hasOpenMarks(written), true);
		assert.equal(hasOpenMarks(serializeBuoyFile({ version: 1, chapter: '正文/第1章.md', marks: [whole] })), false);
		assert.equal(hasOpenMarks('not json'), false);
		assert.deepEqual(parseBuoyFile(written)?.marks, [whole], 'left out while nothing fills it in');

		const chapter = '---\ntitle: 第1章\n---\n他推开门，走了进去。';
		const filled = parseBuoyFile(written, (buoys) => markAt(chapter, 10, buoys, 'assistant', new Date(5)))!;
		assert.deepEqual(filled.marks, [whole, { at: chapter.length, before: chapter, chars: 10, time: '1970-01-01T00:00:00.005Z', by: 'assistant', state: open.state }]);
		assert.equal(said(resolve(G, filled.marks[1].state)), 'in: 收信');
		assert.equal(hasOpenMarks(serializeBuoyFile(filled)), false, 'written back, it is a mark like the others');
		// Numbers the assistant wrote all the same are taken as they are.
		const numbered = JSON.stringify({ version: 1, chapter: '正文/第1章.md', marks: [{ ...open, at: 3, before: '', chars: 3 }] });
		assert.equal(hasOpenMarks(numbered), false);
		assert.equal(parseBuoyFile(numbered)?.marks[0].at, 3);
	});

	test('renamed files: the ids of nodes in them, and in folders, follow', () => {
		const before = state('bridge', '大纲/第一卷/第1章.md#等门', '大纲/第一卷/第10章.md#收信');
		assert.deepEqual(renameState(before, [{ from: '大纲/第一卷/第1章.md', to: '大纲/第一卷/第1章 来信.md' }]).nodes.map((ref) => ref.id), [
			'大纲/第一卷/第1章 来信.md#等门',
			'大纲/第一卷/第10章.md#收信',
		]);
		assert.deepEqual(renameState(before, [{ from: '大纲/第一卷', to: '大纲/卷一' }]).nodes.map((ref) => ref.id), ['大纲/卷一/第1章.md#等门', '大纲/卷一/第10章.md#收信']);
		assert.deepEqual(renameState(state('in', '大纲/第一卷.md'), [{ from: '大纲/第一卷.md', to: '大纲/卷一.md' }]).nodes[0].id, '大纲/卷一.md');
	});
});

describe('asking the model', () => {
	const moves = (position: Position) => choices(G, position).map((list) => list.map((choice) => `${choice.bridge ? '→' : ''}${choice.to?.title ?? '·'}`));

	test('the buoys move one step along the ways of the graph: stay, start towards, be in, fall back', () => {
		assert.deepEqual(moves(at('来信')), [['·', '→等门', '→点灯', '等门', '点灯']], 'the first leaf: no way back; a link is a way on');
		assert.deepEqual(moves(at('渡海')), [['·', '→点灯', '点灯', '收信']]);
		assert.deepEqual(moves(at('点灯')), [['·', '渡海']], 'the last leaf');
		assert.deepEqual(moves(bridgeTo(at('来信'), node('点灯'))), [['·', '点灯', '来信']]);
		assert.deepEqual(moves(parallelWith(at('来信'), node('收信'))), [['·', '等门', '点灯'], ['·', '渡海', '等门']], 'each of two on its own; no bridges');
		assert.deepEqual(moves(parallelWith(at('等门'), node('收信'))), [['·', '来信'], ['·', '渡海']], 'not onto the other buoy');
	});

	test('the answer is a number, or two with their letters; anything else moves nothing', () => {
		const one = choices(G, at('渡海'));
		const pick = (answer: string, position: Position, lists = choices(G, position)) => said(choose(position, readJudgement(answer, lists)));
		assert.equal(pick('2', at('渡海')), 'bridge: 渡海, 点灯');
		assert.equal(pick('选 3。', at('渡海')), 'in: 点灯');
		assert.equal(pick('4', at('渡海')), 'in: 收信');
		assert.equal(pick('1', at('渡海')), 'in: 渡海');
		for (const answer of ['', '不确定', '9', '0']) {
			assert.deepEqual(readJudgement(answer, one), [one[0][0]], answer);
		}
		const bridge = bridgeTo(at('来信'), node('点灯'));
		assert.equal(pick('2', bridge), 'in: 点灯');
		assert.equal(pick('3', bridge), 'in: 来信');
		assert.equal(pick('1', bridge), 'bridge: 来信, 点灯');
		const pair = parallelWith(at('来信'), node('收信'));
		assert.equal(pick('A2 B1', pair), 'parallel: 等门, 收信');
		assert.equal(pick('a1 b2', pair), 'parallel: 来信, 渡海');
		assert.equal(pick('B3', pair), 'parallel: 来信, 等门', 'no answer for A: it stays');
		assert.equal(pick('A2 B3', pair), 'in: 等门', 'both on one node now');
		assert.equal(pick('2 3', pair), 'parallel: 来信, 收信', 'no letters: nothing moves');
	});

	test('the question about a move: where the chapter is, the nodes at hand, the recent text, numbered choices', () => {
		const position = at('渡海');
		const prompt = judgePrompt(position, choices(G, position), '他们去找船。', true);
		assert.equal(prompt.system, JUDGE_INSTRUCTIONS);
		assert.equal(
			prompt.user,
			[
				'<当前位置>\n正文现在写到【渡海】。\n</当前位置>',
				'<节点>\n【渡海】（当前）\n找船。\n\n【点灯】（相邻）\n灯亮了。\n\n【收信】（相邻）\n周伯收下信。\n</节点>',
				'<最近的正文>\n（前略）他们去找船。\n</最近的正文>',
				'选项：\n1. 还在【渡海】里\n2. 【渡海】的内容基本写完了，正在写它和【点灯】之间的衔接\n3. 已经在写【点灯】的内容\n4. 回头去写【收信】的内容了\n\n只回答一个编号。',
			].join('\n\n'),
		);
	});

	test('the question for two buoys asks about each line', () => {
		const pair = parallelWith(at('来信'), node('收信'));
		const { user } = judgePrompt(pair, choices(G, pair), '正文', false);
		assert.ok(user.startsWith('<当前位置>\n正文同时在写【来信】和【收信】。\n</当前位置>'));
		assert.ok(user.includes('<最近的正文>\n正文\n</最近的正文>'));
		assert.ok(
			user.endsWith(
				'选项（两条线各选一个）：\n' +
					'A 线【来信】：\nA1. 这条线还在【来信】里\nA2. 这条线已经在写【等门】的内容\nA3. 这条线已经在写【点灯】的内容\n' +
					'B 线【收信】：\nB1. 这条线还在【收信】里\nB2. 这条线已经在写【渡海】的内容\nB3. 这条线回头去写【等门】的内容了\n\n' +
					'按「A编号 B编号」的格式回答，例如：A1 B2。',
			),
		);
	});

	test('the search over the whole outline: every leaf with what it is under and its first line', () => {
		const prompt = relocatePrompt(G, '第2章 灯塔', '周伯收下了信。', false);
		assert.equal(prompt.system, RELOCATE_INSTRUCTIONS);
		assert.equal(
			prompt.user,
			'<大纲节点>\n' +
				'1. 第一卷 › 第1章 › 来信：信送不出去。\n2. 第一卷 › 第1章 › 等门：等到傍晚。\n' +
				'3. 第一卷 › 第2章 › 收信：周伯收下信。\n4. 第一卷 › 第2章 › 渡海：找船。\n5. 第一卷 › 第2章 › 点灯：灯亮了。\n' +
				'</大纲节点>\n\n<本章正文 文件="第2章 灯塔">\n周伯收下了信。\n</本章正文>\n\n正文末尾在写哪个节点？只回答一个编号。',
		);
		assert.equal(readRelocation('3', G)?.title, '收信');
		assert.equal(readRelocation('是第 5 个。', G)?.title, '点灯');
		assert.equal(readRelocation('6', G), undefined);
		assert.equal(readRelocation('不知道', G), undefined);
	});
});
