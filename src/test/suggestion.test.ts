import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CURSOR } from '../core/context';
import { extractSuggestion, type Suggestion } from '../core/suggestion';

interface Options {
	final?: boolean;
	after?: string;
	maxChars?: number;
	cutOff?: boolean;
}

function run(raw: string, before = '前文。', options: Options = {}): Suggestion {
	return extractSuggestion(raw, {
		before,
		after: options.after ?? '',
		maxChars: options.maxChars ?? 100,
		final: options.final ?? true,
		cutOff: options.cutOff,
	});
}

const ok = (text: string): Suggestion => ({ status: 'ok', text });

describe('how much is shown', () => {
	test('the model stopped within the limit: all of it, however many sentences', () => {
		assert.deepEqual(run('他推开门，走了进去。屋里很暗。'), ok('他推开门，走了进去。屋里很暗。'));
		assert.deepEqual(run('她愣住了……然后笑了。'), ok('她愣住了……然后笑了。'));
	});

	test('the stream ended without a sentence end: show what there is', () => {
		assert.deepEqual(run('他笑了笑'), ok('他笑了笑'));
		assert.deepEqual(run('他推开门。屋里很暗，什么也'), ok('他推开门。屋里很暗，什么也'));
	});

	test('over the limit: cut after the last sentence end within it', () => {
		const raw = '他推开门，走了进去。屋里很暗，什么也看不见。他摸到了墙上的灯绳。';
		assert.deepEqual(run(raw, '前文。', { maxChars: 21 }), ok('他推开门，走了进去。'));
		assert.deepEqual(run(raw, '前文。', { maxChars: 22 }), ok('他推开门，走了进去。屋里很暗，什么也看不见。'));
		assert.deepEqual(run(raw, '前文。', { maxChars: 31 }), ok('他推开门，走了进去。屋里很暗，什么也看不见。'));
	});

	test('closing quotes and stacked marks stay with their sentence: one that does not fit with them is left out', () => {
		const raw = '「快走。」「等等我。」他回头看了一眼。';
		assert.deepEqual(run(raw, '前文。', { maxChars: 10 }), ok('「快走。」'), 'the limit falls between 。 and 」');
		assert.deepEqual(run(raw, '前文。', { maxChars: 11 }), ok('「快走。」「等等我。」'));
		assert.deepEqual(run('真的吗？！他问了一句，没有人回答。', '前文。', { maxChars: 6 }), ok('真的吗？！'));
		assert.deepEqual(run('她愣住了……然后笑了起来，笑得很轻。', '前文。', { maxChars: 8 }), ok('她愣住了……'));
	});

	test('no sentence end within the limit: cut at the last comma-like break in its second half, or at the limit', () => {
		const raw = `他${'很'.repeat(20)}，${'慢'.repeat(30)}。`;
		assert.deepEqual(run(raw, '前文。', { maxChars: 30 }), ok(`他${'很'.repeat(20)}，`));
		assert.deepEqual(run(`${'啊'.repeat(80)}。`, '前文。', { maxChars: 30 }), ok('啊'.repeat(30)));
	});

	test('English: a period followed by a space ends a sentence, a decimal point does not', () => {
		const raw = ' and stepped inside. The room was dark and cold.';
		assert.deepEqual(run(raw, 'He opened the door', { maxChars: 30 }), ok(' and stepped inside.'));
		assert.deepEqual(run(raw, 'He opened the door'), ok(raw));
		assert.deepEqual(run('Version 3.5 was out. Next came the long wait.', 'x ', { maxChars: 25 }), ok('Version 3.5 was out.'));
	});

	test('cut off by the output cap: ends at the last sentence end, like text over the limit', () => {
		assert.deepEqual(run('他推开门。屋里很暗，什么也', '前文。', { cutOff: true }), ok('他推开门。'));
		assert.deepEqual(run('他推开门，屋里很暗', '前文。', { cutOff: true }), ok('他推开门，屋里很暗'), 'no sentence end: what there is');
	});
});

describe('paragraphs', () => {
	test('several paragraphs are kept', () => {
		assert.deepEqual(run('他慢慢地走出了院子。\n\n第二天，雾散了。'), ok('他慢慢地走出了院子。\n\n第二天，雾散了。'));
	});

	test('breaks are written the way the text has them: a blank line or just a line break', () => {
		assert.deepEqual(run('灯灭了。\n她站起来。', '第一段。\n\n第二段。'), ok('灯灭了。\n\n她站起来。'));
		assert.deepEqual(run('灯灭了。\n\n\n她站起来。', '第一段。\n第二段。'), ok('灯灭了。\n她站起来。'));
		assert.deepEqual(run('灯灭了。 \n \n\n\n她站起来。', '只有一段。'), ok('灯灭了。\n\n她站起来。'), 'nothing to go by: as written, one blank line at most');
		assert.deepEqual(run('灯灭了。\n她站起来。', '# 第一章\n\n只有一段。'), ok('灯灭了。\n她站起来。'), 'the blank line after a heading says nothing');
		assert.deepEqual(run('灯灭了。\n她站起来。', '第一段。\r\n\r\n第二段。'), ok('灯灭了。\n\n她站起来。'), 'CRLF');
	});

	test('new paragraphs get the indent the text has, and lose one it does not have', () => {
		assert.deepEqual(run('灯灭了。\n\n她站起来。', '　　第一段。\n　　第二段。'), ok('灯灭了。\n　　她站起来。'));
		assert.deepEqual(run('灯灭了。\n　　她站起来。', '第一段。\n\n第二段。'), ok('灯灭了。\n\n她站起来。'));
		assert.deepEqual(run('灯灭了。\n　　她站起来。', '---\ntitle: 雾\n---\n　　只有一段。'), ok('灯灭了。\n　　她站起来。'), 'frontmatter is not a paragraph');
	});

	test('at a line start', () => {
		assert.deepEqual(run('第二天，雾还没有散。', '　　上一段。\n'), ok('　　第二天，雾还没有散。'));
		assert.deepEqual(run('\n　　第二天，雾还没有散。', '上一段。\n'), ok('第二天，雾还没有散。'));
		assert.deepEqual(run('\n　　雾从海上来。', '# 第一章\n\n'), ok('　　雾从海上来。'), 'no paragraph yet: the indent the model wrote is kept');
		assert.deepEqual(run('  雾从海上来。', ''), ok('雾从海上来。'));
	});

	test('the model starts a new paragraph after a finished one: the break is kept, in the style of the text', () => {
		assert.deepEqual(run('\n\n第二天，雾散了。', '他走了。'), ok('\n\n第二天，雾散了。'));
		assert.deepEqual(run('\n第二天，雾散了。', '第一段。\n\n他走了。'), ok('\n\n第二天，雾散了。'));
		assert.deepEqual(run('\n\n第二天，雾散了。', '　　第一段。\n　　“走吧。”'), ok('\n　　第二天，雾散了。'));
		assert.deepEqual(run('\n\n雾从海上来。', '# 第三章 夜雾'), ok('\n\n雾从海上来。'), 'after a heading');
		assert.deepEqual(run('\n\n「明天带我去灯塔。」', '「别敲了。」\n\n他开口时声音很轻：'), ok('\n\n「明天带我去灯塔。」'), 'speech after a colon');
	});

	test('a break in the middle of a sentence, or with text after the cursor, is dropped', () => {
		assert.deepEqual(run('\n\n了一句话就走了，留下我们面面相觑。', '他说'), ok('了一句话就走了，留下我们面面相觑。'));
		assert.deepEqual(run('\n\n第二天，雾散了。', '他走了。', { after: '（完）' }), ok('第二天，雾散了。'));
	});

	test('a paragraph end is a place to cut', () => {
		const raw = `他慢慢地走出了院子，没有回头\n\n${'很'.repeat(40)}`;
		assert.deepEqual(run(raw, '前文。', { maxChars: 30 }), ok('他慢慢地走出了院子，没有回头'));
	});
});

describe('while streaming', () => {
	const streaming = (raw: string, options: Options = {}, before = '前文。') => run(raw, before, { ...options, final: false });

	test('waits for 12 characters before judging, so a preamble can be recognised', () => {
		assert.equal(streaming('好的。').status, 'pending');
		assert.equal(streaming('好的，以下是续写：').status, 'meta');
	});

	test('within the limit nothing is settled: the model may go on, or stop by itself', () => {
		assert.equal(streaming('他推开门，走了进去。屋里很暗。').status, 'pending');
		assert.equal(streaming('他推开门，走了进去。\n\n屋里很暗。\n\n').status, 'pending');
	});

	test('settled as soon as the text is longer than the limit', () => {
		const raw = '他推开门，走了进去。屋里很暗，看不见人。';
		assert.equal(raw.length, 20);
		assert.equal(streaming(raw, { maxChars: 20 }).status, 'pending', 'exactly the limit: closing quotes may still follow');
		assert.deepEqual(streaming(`${raw}他`, { maxChars: 20 }), ok(raw));
		assert.deepEqual(streaming(`${raw}」`, { maxChars: 20 }), ok('他推开门，走了进去。'), 'with its quote the second sentence does not fit');
		assert.equal(streaming('啊'.repeat(60), { maxChars: 60 }).status, 'pending');
		assert.deepEqual(streaming('啊'.repeat(61), { maxChars: 60 }), ok('啊'.repeat(60)));
	});

	test('settled where the text reaches what follows the cursor, once it is known that no more closers come', () => {
		const raw = '你好啊，好久不见，进来坐吧。我等你很久了。」';
		const options = { after: '」' };
		assert.equal(streaming('你好啊，好久不见，进来坐吧。', options, '他说：「').status, 'pending');
		assert.equal(streaming(raw, options, '他说：「').status, 'pending');
		assert.deepEqual(streaming(`${raw}他`, options, '他说：「'), ok('你好啊，好久不见，进来坐吧。我等你很久了。'));
	});
});

describe('echo of the text before the cursor', () => {
	test('a repeated clause is removed', () => {
		assert.deepEqual(run('他推开门，走了进去。屋里很暗。', '雨停了。他推开门，'), ok('走了进去。屋里很暗。'));
	});

	test('a repeated opening quote is removed', () => {
		assert.deepEqual(run('「你好啊，好久不见。」', '他说：「'), ok('你好啊，好久不见。」'));
	});

	test('a single matching character is kept: it is usually a new word', () => {
		assert.deepEqual(run('张开的嘴，说不出话来。', '他看着张'), ok('张开的嘴，说不出话来。'));
	});

	test('while the output so far only repeats, wait', () => {
		assert.equal(run('走了进去', '他推开门，走了进去', { final: false }).status, 'pending');
	});

	test('the echo ends right before a full stop: the stop finishes the old sentence', () => {
		assert.deepEqual(run('走了进去。屋里很暗，什么也看不见。', '他推开门，走了进去'), ok('。屋里很暗，什么也看不见。'));
	});

	test('a new paragraph after the repeated sentence is still a new paragraph', () => {
		assert.deepEqual(run('他走了。\n\n第二天，雾散了。', '第一段。\n\n他走了。'), ok('\n\n第二天，雾散了。'));
	});
});

describe('replies that are not prose', () => {
	test('preambles and refusals are dropped', () => {
		for (const raw of [
			'好的，以下是续写：他推开门。',
			'以下是续写内容：他推开门。',
			'续写：他推开门，走了进去。',
			'根据您提供的设定，他推开门。',
			'Sure, here is the next sentence.',
			'抱歉，我无法继续这段内容。',
		]) {
			assert.equal(run(raw).status, 'meta', raw);
		}
	});

	test('inside dialogue a character may say 「好的，下面……」 or 「对不起，我不能……」', () => {
		assert.deepEqual(run('好的，下面我们说正事。」他坐下了。', '他点点头：「'), ok('好的，下面我们说正事。」他坐下了。'));
		assert.deepEqual(run('对不起，我不能去。」她说。', '“我……”她低声说，“'), ok('对不起，我不能去。」她说。'));
	});

	test('empty replies', () => {
		assert.equal(run('').status, 'empty');
		assert.equal(run('  \n ').status, 'empty');
		assert.equal(run('', '前文。', { final: false }).status, 'pending');
	});
});

describe('cleanup', () => {
	test('the text ends where it reaches the punctuation already after the cursor, which is not repeated', () => {
		const accept = (before: string, raw: string, after: string) => before + run(raw, before, { after }).text + after;
		assert.equal(accept('他说：「', '你好。」他笑了，转身走了。', '」'), '他说：「你好。」');
		assert.equal(accept('他说：「', '你好。我等你很久了。」他笑了，转身走了。', '」'), '他说：「你好。我等你很久了。」', 'not at the first sentence end');
		assert.equal(accept('他说：“', '你好。”他转过身去。', '。”'), '他说：“你好。”');
		assert.equal(accept('（他说：“', '你好。”他转过身去。', '”）'), '（他说：“你好。”）');
		assert.equal(accept('她犹豫着', '要不要开口……”她低下头。', '……”'), '她犹豫着要不要开口……”');
		assert.equal(accept('He said, "', 'Come in." She smiled.', '"'), 'He said, "Come in."');
		assert.equal(accept('他说：“', '你好。', '”'), '他说：“你好。”', 'a different closer is kept');
		assert.equal(accept('他说：「', '你好', '」\n下一段。'), '他说：「你好」\n下一段。', 'only the rest of the line counts');
	});

	test('the space between English words is kept; none is added to Chinese or inside a word', () => {
		const accept = (before: string, raw: string) => before + run(raw, before).text;
		assert.equal(accept('He opened the door', ' and stepped inside. It was dark.'), 'He opened the door and stepped inside. It was dark.');
		assert.equal(accept('He opened the door', 'the door and stepped inside.'), 'He opened the door and stepped inside.');
		assert.equal(accept('He said,', ' “Come in.” She smiled.'), 'He said, “Come in.” She smiled.');
		assert.equal(accept('He opened the do', 'or and stepped inside.'), 'He opened the door and stepped inside.');
		assert.equal(accept('他推开门', ' 走了进去。'), '他推开门走了进去。');
		assert.equal(accept('他说：', ' “走吧。”'), '他说：“走吧。”');
		assert.equal(accept('He left.', ' \n\nThe next day the fog was gone.'), 'He left.\n\nThe next day the fog was gone.');
	});

	test('leading whitespace is dropped mid-line; whitespace at the end is dropped', () => {
		assert.deepEqual(run('  了一句话就走了，留下我们面面相觑。', '他说'), ok('了一句话就走了，留下我们面面相觑。'));
		assert.deepEqual(run('他推开门，走了进去。\n\n', '前文。'), ok('他推开门，走了进去。'));
	});

	test('the cursor marker is removed if the model repeats it', () => {
		assert.deepEqual(run(`${CURSOR}他推开门，走了进去。`), ok('他推开门，走了进去。'));
	});
});
