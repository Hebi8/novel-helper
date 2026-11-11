import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildContext, CURSOR, type ContextInput, type ContextLimits, INSTRUCTIONS } from '../core/context';
import { Library } from '../core/library';

function library(): Library {
	const lib = new Library();
	lib.setLore('设定/文风.md', '---\nalways: true\ntype: 文风\n---\n第三人称，短句。');
	lib.setLore('设定/世界观.md', `---\nalways: true\n---\n${'雾'.repeat(300)}`);
	lib.setLore('人物/张三.md', '---\naliases: [三哥]\ntype: 人物\nsummary: 张三的摘要\n---\n张三的正文');
	lib.setLore('人物/张三丰.md', `---\ntype: 人物\n---\n${'丰'.repeat(100)}`);
	lib.setLore('人物/李四.md', '李四的正文');
	lib.setLore('人物/王五.md', '王五的正文');
	return lib;
}

const LIMITS: ContextLimits = {
	beforeChars: 100,
	afterChars: 20,
	scanChars: 200,
	alwaysChars: 30,
	matchedChars: 30,
	entryChars: 40,
	outlineChars: 30,
	previousChapterChars: 10,
};

function input(overrides: Partial<ContextInput> = {}): ContextInput {
	const lib = library();
	return {
		documentPath: '正文/第3章 夜雾.md',
		before: `张三丰走了。${'。'.repeat(50)}三哥笑了。李四说`,
		after: '',
		entries: lib.entries(),
		matcher: lib.matcher(),
		previous: [],
		limits: LIMITS,
		...overrides,
	};
}

describe('buildContext: entries and budgets', () => {
	test('always-on entries go into the system prompt until their budget runs out', () => {
		const { prompt, trace } = buildContext(input());
		assert.ok(prompt.system.startsWith(INSTRUCTIONS));
		assert.match(prompt.system, /<常驻资料>\n【文风】（文风）\n第三人称，短句。\n<\/常驻资料>/);
		assert.deepEqual(trace.always.map((e) => e.name), ['文风']);
		const skipped = trace.skipped.find((e) => e.name === '世界观');
		assert.ok(skipped?.always, 'cut to 40 chars, with its name line it does not fit the 30-char budget');
		assert.equal(skipped.chars, '【世界观】\n'.length + 40 + '（后略）'.length);
	});

	test('matched entries: nearest first, longest match, budget enforced', () => {
		const { prompt, trace } = buildContext(input());
		assert.deepEqual(trace.matched.map((e) => e.name), ['李四', '张三']);
		const zhang = trace.matched[1];
		assert.equal(zhang.source, 'summary');
		assert.deepEqual([...zhang.hit!.keys], [['三哥', 1]], '「张三丰」 does not count as a mention of 张三');
		const fung = trace.skipped.find((e) => e.name === '张三丰');
		assert.ok(fung && !fung.always && fung.hit, 'over budget: 李四 and 张三 used all 30 chars');
		assert.match(prompt.dynamic, /<本章涉及的资料>\n【李四】\n李四的正文\n\n【张三】（人物；别名：三哥）\n张三的摘要\n<\/本章涉及的资料>/);
		assert.ok(!prompt.dynamic.includes('丰丰'));
	});

	test('a long entry is cut to the per-entry cap and marked', () => {
		const { prompt, trace } = buildContext(input({ limits: { ...LIMITS, matchedChars: 100 } }));
		const fung = trace.matched.find((e) => e.name === '张三丰')!;
		assert.equal(fung.truncated, true);
		assert.equal(fung.chars, '【张三丰】（人物）\n'.length + 40 + '（后略）'.length);
		assert.ok(prompt.dynamic.includes(`${'丰'.repeat(40)}（后略）`));
	});

	test('the name line counts against the budget: many aliases take room, a zero budget sends nothing', () => {
		const lib = library();
		const aliases = Array.from({ length: 20 }, (_, i) => `王五${i}号`).join(', ');
		lib.setLore('人物/王五.md', `---\naliases: [${aliases}]\n---\n短。`);
		const { trace } = buildContext(
			input({ before: '王五来了。', entries: lib.entries(), matcher: lib.matcher(), limits: { ...LIMITS, matchedChars: 100 } }),
		);
		const wang = trace.skipped.find((e) => e.name === '王五');
		assert.ok(wang && wang.chars > 100, `${wang?.chars} chars with its aliases`);

		const none = buildContext(input({ limits: { ...LIMITS, alwaysChars: 0, matchedChars: 0 } }));
		assert.deepEqual([none.trace.always, none.trace.matched], [[], []]);
		assert.ok(!none.prompt.system.includes('<常驻资料>') && !none.prompt.dynamic.includes('<本章涉及的资料>'));
	});

	test('always-on entries are not repeated among matches', () => {
		const { trace } = buildContext(input({ before: '他想起文风的事。' }));
		assert.deepEqual(trace.matched, []);
	});

	test('names in the outline pull entries in', () => {
		const { prompt, trace } = buildContext(
			input({ before: '雨停了。', outline: { path: '大纲/第3章 夜雾.md', content: '---\nx: 1\n---\n王五登场。' } }),
		);
		assert.deepEqual(trace.matched.map((e) => [e.name, e.hit!.inOutline]), [['王五', true]]);
		assert.match(prompt.stable, /<本章大纲>\n王五登场。\n<\/本章大纲>/);
		assert.deepEqual(trace.outline, { path: '大纲/第3章 夜雾.md', chars: 5, truncated: false });
	});
});

describe('buildContext: chapters and text', () => {
	test('previous chapters: summary when there is one, else the end of the chapter', () => {
		const { prompt, trace } = buildContext(
			input({
				previous: [
					{ path: '正文/第1章.md', summary: '---\ntype: 摘要\n---\n第一章的摘要' },
					{ path: '正文/第2章.md', text: '开头。\n中间的一段。\n最后的一句话。' },
				],
			}),
		);
		assert.deepEqual(
			trace.previous.map((p) => [p.path, p.source, p.chars, p.truncated]),
			[
				['正文/第1章.md', 'summary', 6, false],
				['正文/第2章.md', 'ending', 7, true],
			],
		);
		assert.equal(prompt.stable, '<前文>\n【第1章】摘要：\n第一章的摘要\n\n【第2章】结尾：\n（前略）最后的一句话。\n</前文>');
	});

	test('section order: system, then previous chapters and outline, then lore and the chapter text', () => {
		const { prompt } = buildContext(
			input({ previous: [{ path: '正文/第2章.md', summary: '摘要' }], outline: { path: 'o.md', content: '大纲' } }),
		);
		assert.ok(prompt.stable.indexOf('<前文>') < prompt.stable.indexOf('<本章大纲>'));
		assert.ok(prompt.dynamic.indexOf('<本章涉及的资料>') < prompt.dynamic.indexOf('<当前章节'));
		assert.ok(prompt.dynamic.endsWith(`从 ${CURSOR} 处接着写一句。`));
	});

	test('text around the cursor: frontmatter dropped, long text cut from the front, cursor marked', () => {
		const before = `---\ntitle: x\n---\n${'前'.repeat(10)}\n${'后'.repeat(95)}他说`;
		const { prompt, trace } = buildContext(input({ before, after: '」\n下一段' }));
		assert.deepEqual(trace.before, { chars: 97, truncated: true }, 'cut, then moved to the next line start');
		assert.ok(prompt.dynamic.includes(`<当前章节 文件="第3章 夜雾">\n（前略）${'后'.repeat(95)}他说${CURSOR}」\n下一段\n</当前章节>`));
		assert.ok(!prompt.dynamic.includes('title: x'));
	});

	test('no previous chapters or outline: the stable part is empty', () => {
		const { prompt, trace } = buildContext(input({ before: '开头', after: '' }));
		assert.equal(prompt.stable, '');
		assert.equal(trace.outline, undefined);
		assert.ok(prompt.dynamic.includes(`开头${CURSOR}\n</当前章节>`));
	});
});
