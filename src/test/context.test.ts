import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildContext, CURSOR, type ContextInput, type ContextLimits, INSTRUCTIONS, TEXT_CHUNK_CHARS, userText } from '../core/context';
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
	alwaysChars: 30,
	matchedChars: 30,
	entryChars: 40,
	bookOutlineChars: 30,
	levelOutlineChars: 20,
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
		levels: [],
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

	test('matched entries: nearest kept first, longest match, budget enforced; laid out in order of first mention', () => {
		const { prompt, trace } = buildContext(input());
		assert.deepEqual(trace.matched.map((e) => e.name), ['张三', '李四']);
		const zhang = trace.matched[0];
		assert.equal(zhang.source, 'summary');
		assert.deepEqual([...zhang.hit!.keys], [['三哥', 1]], '「张三丰」 does not count as a mention of 张三');
		const fung = trace.skipped.find((e) => e.name === '张三丰');
		assert.ok(fung && !fung.always && fung.hit, 'over budget: 李四 and 张三, nearer the cursor, used all 30 chars');
		const user = userText(prompt);
		assert.match(user, /<本章涉及的资料>\n【张三】（人物；别名：三哥）\n张三的摘要\n\n【李四】\n李四的正文\n<\/本章涉及的资料>/);
		assert.ok(!user.includes('丰丰'));
	});

	test('a newly named entry is added after the ones already there; entries named in the outline come first', () => {
		const outline = { path: '大纲/第3章 夜雾.md', content: '王五登场。' };
		const limits = { ...LIMITS, matchedChars: 200, beforeChars: 1000 };
		const names = (before: string) => buildContext(input({ before, outline, limits })).trace.matched.map((e) => e.name);
		assert.deepEqual(names('李四来了。'), ['王五', '李四']);
		assert.deepEqual(names('李四来了。三哥也来了。'), ['王五', '李四', '张三']);
		assert.deepEqual(names('李四来了。三哥也来了。王五和李四说话。'), ['王五', '李四', '张三'], 'more mentions move nothing');
	});

	test('a long entry is cut to the per-entry cap and marked', () => {
		const { prompt, trace } = buildContext(input({ limits: { ...LIMITS, matchedChars: 100 } }));
		const fung = trace.matched.find((e) => e.name === '张三丰')!;
		assert.equal(fung.truncated, true);
		assert.equal(fung.chars, '【张三丰】（人物）\n'.length + 40 + '（后略）'.length);
		assert.ok(userText(prompt).includes(`${'丰'.repeat(40)}（后略）`));
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
		assert.ok(!none.prompt.system.includes('<常驻资料>') && !userText(none.prompt).includes('<本章涉及的资料>'));
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
		assert.match(prompt.user[0].text, /<本章大纲>\n王五登场。\n<\/本章大纲>/);
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
		assert.deepEqual(prompt.user[0], {
			text: '<前文>\n【第1章】摘要：\n第一章的摘要\n\n【第2章】结尾：\n（前略）最后的一句话。\n</前文>\n\n',
			cache: true,
		});
	});

	test('outlines of the book and the levels come first, each under its own cap', () => {
		const { prompt, trace } = buildContext(
			input({
				levels: [
					{ name: '全书', book: true, outline: { path: '大纲/全书.md', content: `---\nx: 1\n---\n${'书'.repeat(40)}` } },
					{ name: '第一卷', book: false },
					{ name: '第一幕', book: false, outline: { path: '大纲/第一卷/第一幕.md', content: '王五在这一幕登场。' } },
				],
				previous: [{ path: '正文/第2章.md', summary: '摘要' }],
				outline: { path: '大纲/第3章 夜雾.md', content: '本章' },
			}),
		);
		assert.equal(
			prompt.user[0].text,
			`<上层大纲>\n【全书】\n${'书'.repeat(30)}（后略）\n\n【第一幕】\n王五在这一幕登场。\n</上层大纲>\n\n` +
				'<前文>\n【第2章】摘要：\n摘要\n</前文>\n\n<本章大纲>\n本章\n</本章大纲>\n\n',
		);
		assert.deepEqual(trace.levels, [
			{ name: '全书', book: true, path: '大纲/全书.md', chars: 30, truncated: true },
			{ name: '第一卷', book: false, path: undefined, chars: 0, truncated: false },
			{ name: '第一幕', book: false, path: '大纲/第一卷/第一幕.md', chars: 9, truncated: false },
		]);
		assert.deepEqual(trace.matched.map((e) => e.name), ['张三', '李四'], 'names in the level outlines bring nothing in');
	});

	test('section order: outlines, then lore, then the chapter text; the request to continue comes last', () => {
		const { prompt } = buildContext(
			input({ previous: [{ path: '正文/第2章.md', summary: '摘要' }], outline: { path: 'o.md', content: '大纲' } }),
		);
		const user = userText(prompt);
		const at = (text: string) => user.indexOf(text);
		assert.ok(at('<前文>') < at('<本章大纲>') && at('<本章大纲>') < at('<本章涉及的资料>') && at('<本章涉及的资料>') < at('<当前章节'));
		assert.ok(user.endsWith(`从 ${CURSOR} 处接着写一句。`));
	});

	test('text around the cursor: frontmatter dropped, cursor marked, text after the cursor capped', () => {
		const before = `---\ntitle: x\n---\n第一行。\n他说`;
		const { prompt, trace } = buildContext(input({ before, after: `」\n下一段${'。'.repeat(30)}` }));
		assert.deepEqual(trace.before, { chars: 7, truncated: false });
		assert.deepEqual(trace.after, { chars: 20, truncated: true });
		assert.deepEqual(prompt.user, [
			{
				text: `<当前章节 文件="第3章 夜雾">\n第一行。\n他说${CURSOR}」\n下一段${'。'.repeat(15)}（后略）\n</当前章节>\n\n从 ${CURSOR} 处接着写一句。`,
				cache: false,
			},
		]);
	});

	test('no previous chapters, outline or lore: one block, nothing to cache in it', () => {
		const { prompt, trace } = buildContext(input({ before: '开头', after: '' }));
		assert.equal(trace.outline, undefined);
		assert.deepEqual(prompt.user.map((b) => b.cache), [false]);
		assert.ok(prompt.user[0].text.includes(`开头${CURSOR}\n</当前章节>`));
	});
});

/** A chapter of `count` lines, 50 characters each with its line break. */
function lines(count: number, from = 0): string {
	return Array.from({ length: count }, (_, i) => `${String(from + i).padStart(4, '0')}${'字'.repeat(45)}\n`).join('');
}

describe('buildContext: one request is a prefix of the next', () => {
	const limits = { ...LIMITS, beforeChars: 3000, matchedChars: 200 };
	const outline = { path: '大纲/第3章 夜雾.md', content: '王五登场。' };
	const build = (before: string) => buildContext(input({ before, outline, limits })).prompt.user;

	test('the chapter is sent from its start, in pieces that end with a line; breakpoints after the outlines and the last two pieces', () => {
		const user = build(`${lines(20)}李四说`);
		assert.equal(TEXT_CHUNK_CHARS, 300);
		assert.deepEqual(
			user.map((b) => [b.text.length, b.cache]),
			[
				['<本章大纲>\n王五登场。\n</本章大纲>\n\n'.length, true],
				['<本章涉及的资料>\n【王五】\n王五的正文\n\n【李四】\n李四的正文\n</本章涉及的资料>\n\n'.length, false],
				['<当前章节 文件="第3章 夜雾">\n'.length + 300, false],
				[300, true],
				[300, true],
				[100 + `李四说${CURSOR}\n</当前章节>\n\n从 ${CURSOR} 处接着写一句。`.length, false],
			],
		);
		assert.ok(user[3].text.startsWith('0006') && user[3].text.endsWith('\n'));
		assert.ok(userText({ system: '', user }).includes(`${lines(20)}李四说${CURSOR}`), 'joined, the blocks are the chapter');
	});

	test('typing on leaves every finished block as it was', () => {
		const earlier = build(`${lines(13)}他`);
		const later = build(`${lines(13)}他推开门，走了进去。\n${lines(7, 13)}屋里`);
		// Outlines, lore, two finished pieces, the tail; then a third piece is finished.
		assert.deepEqual(earlier.map((b) => b.cache), [true, false, true, true, false]);
		assert.deepEqual(later.map((b) => b.cache), [true, false, false, true, true, false]);
		assert.deepEqual(later.slice(0, 4).map((b) => b.text), earlier.slice(0, 4).map((b) => b.text));
		// The later request has a breakpoint where the earlier one left its last cache entry, and adds one piece to it.
		assert.ok(earlier[3].cache && later[3].cache);
	});

	test('a new name in the text changes the lore block and nothing before it', () => {
		const earlier = build(`${lines(13)}他`);
		const later = build(`${lines(13)}他看见三哥`);
		assert.equal(later[0].text, earlier[0].text);
		assert.ok(later[1].text.startsWith(earlier[1].text.replace('\n</本章涉及的资料>\n\n', '')), 'the new entry is added at the end');
		assert.deepEqual(later.slice(2, 4), earlier.slice(2, 4));
	});

	test('a chapter over the limit loses a third of the limit from its start, and keeps that start until the next third', () => {
		const start = (count: number) => {
			const { prompt, trace } = buildContext(input({ before: lines(count), limits }));
			const text = userText(prompt);
			return [trace.before.truncated, trace.before.chars, text.slice(text.indexOf('（前略）') + 4, text.indexOf('（前略）') + 8)];
		};
		assert.deepEqual(buildContext(input({ before: lines(60), limits })).trace.before, { chars: 3000, truncated: false });
		assert.deepEqual(start(61), [true, 2050, '0020']);
		assert.deepEqual(start(80), [true, 3000, '0020']);
		assert.deepEqual(start(81), [true, 2050, '0040']);
	});

	test('names are searched in all of the text that is sent', () => {
		const { trace } = buildContext(input({ before: `李四来了。\n${lines(40)}`, limits }));
		assert.deepEqual(trace.matched.map((e) => [e.name, e.hit!.nearest]), [['李四', 2004]]);
	});
});
