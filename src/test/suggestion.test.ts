import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CURSOR } from '../core/context';
import { extractSuggestion, type Suggestion } from '../core/suggestion';

function run(raw: string, before = '前文。', options: { final?: boolean; after?: string; maxChars?: number } = {}): Suggestion {
	return extractSuggestion(raw, {
		before,
		after: options.after ?? '',
		maxChars: options.maxChars ?? 60,
		final: options.final ?? true,
	});
}

const ok = (text: string): Suggestion => ({ status: 'ok', text });

describe('first sentence', () => {
	test('stops at the first sentence end', () => {
		assert.deepEqual(run('他推开门，走了进去。屋里很暗。'), ok('他推开门，走了进去。'));
	});

	test('keeps the closing quote after the full stop', () => {
		assert.deepEqual(run('你来了。」他笑了。', '他说：「'), ok('你来了。」'));
	});

	test('ellipsis runs and stacked marks stay together', () => {
		assert.deepEqual(run('她愣住了……然后笑了。'), ok('她愣住了……'));
		assert.deepEqual(run('真的吗？！他问。'), ok('真的吗？！'));
	});

	test('a newline ends the sentence', () => {
		assert.deepEqual(run('他慢慢地走出了院子，没有回头\n第二段'), ok('他慢慢地走出了院子，没有回头'));
	});

	test('English: a period followed by a space ends the sentence, a decimal point does not', () => {
		assert.deepEqual(run(' and stepped inside. The room was dark.', 'He opened the door'), ok(' and stepped inside.'));
		assert.deepEqual(run('Version 3.5 was out. Next.', 'x '), ok('Version 3.5 was out.'));
	});

	test('the stream ended without a sentence end: show what there is', () => {
		assert.deepEqual(run('他笑了笑'), ok('他笑了笑'));
	});

	test('too long: cut at the last comma-like break in the second half', () => {
		const raw = `他${'很'.repeat(20)}，${'慢'.repeat(30)}。`;
		assert.deepEqual(run(raw, '前文。', { maxChars: 30 }), ok(`他${'很'.repeat(20)}，`));
		assert.deepEqual(run(`${'啊'.repeat(80)}。`, '前文。', { maxChars: 30 }), ok('啊'.repeat(30)));
	});
});

describe('while streaming', () => {
	test('waits for 12 characters before judging, so a preamble can be recognised', () => {
		assert.equal(run('好的。', '前文。', { final: false }).status, 'pending');
		assert.equal(run('好的，以下是续写：', '前文。', { final: false }).status, 'meta');
	});

	test('waits for closing quotes that may still follow the full stop', () => {
		const raw = '他看了看四周，低声说道：「快走。';
		assert.equal(run(raw, '前文。', { final: false }).status, 'pending');
		assert.deepEqual(run(`${raw}」`, '前文。', { final: false }).status, 'pending');
		assert.deepEqual(run(`${raw}」他`, '前文。', { final: false }), ok(`${raw}」`));
	});

	test('a long sentence without an end yet is pending until the cap', () => {
		assert.equal(run('他走在很长很长很长很长的路上，', '前文。', { final: false }).status, 'pending');
		assert.equal(run('啊'.repeat(61), '前文。', { final: false }).status, 'ok');
	});
});

describe('echo of the text before the cursor', () => {
	test('a repeated clause is removed', () => {
		assert.deepEqual(run('他推开门，走了进去。屋里很暗。', '雨停了。他推开门，'), ok('走了进去。'));
	});

	test('a repeated opening quote is removed', () => {
		assert.deepEqual(run('「你好啊，好久不见。」', '他说：「'), ok('你好啊，好久不见。」'));
	});

	test('a single matching character is kept: it is usually a new word', () => {
		assert.deepEqual(run('张开的嘴，说不出话来。还有', '他看着张'), ok('张开的嘴，说不出话来。'));
	});

	test('while the output so far only repeats, wait', () => {
		assert.equal(run('走了进去', '他推开门，走了进去', { final: false }).status, 'pending');
	});

	test('the echo ends right before a full stop: the stop finishes the old sentence', () => {
		assert.deepEqual(run('走了进去。屋里很暗，什么也看不见。', '他推开门，走了进去'), ok('。屋里很暗，什么也看不见。'));
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
		assert.deepEqual(run('好的，下面我们说正事。」他坐下了。', '他点点头：「'), ok('好的，下面我们说正事。」'));
		assert.deepEqual(run('对不起，我不能去。」她说。', '“我……”她低声说，“'), ok('对不起，我不能去。」'));
	});

	test('empty replies', () => {
		assert.equal(run('').status, 'empty');
		assert.equal(run('  \n ').status, 'empty');
		assert.equal(run('', '前文。', { final: false }).status, 'pending');
	});
});

describe('cleanup', () => {
	test('punctuation already after the cursor is not repeated', () => {
		const accept = (before: string, raw: string, after: string) => before + run(raw, before, { after }).text + after;
		assert.equal(accept('他说：「', '你好。」他笑了，转身走了。', '」'), '他说：「你好。」');
		assert.equal(accept('他说：“', '你好。”他转过身去。', '。”'), '他说：“你好。”');
		assert.equal(accept('（他说：“', '你好。”他转过身去。', '”）'), '（他说：“你好。”）');
		assert.equal(accept('她犹豫着', '要不要开口……”她低下头。', '……”'), '她犹豫着要不要开口……”');
		assert.equal(accept('He said, "', 'Come in." She smiled.', '"'), 'He said, "Come in."');
		assert.equal(accept('他说：“', '你好。', '”'), '他说：“你好。”', 'a different closer is kept');
	});

	test('the space between English words is kept; none is added to Chinese or inside a word', () => {
		const accept = (before: string, raw: string) => before + run(raw, before).text;
		assert.equal(accept('He opened the door', ' and stepped inside. It was dark.'), 'He opened the door and stepped inside.');
		assert.equal(accept('He opened the door', 'the door and stepped inside.'), 'He opened the door and stepped inside.');
		assert.equal(accept('He said,', ' “Come in.” She smiled.'), 'He said, “Come in.”');
		assert.equal(accept('He opened the do', 'or and stepped inside.'), 'He opened the door and stepped inside.');
		assert.equal(accept('他推开门', ' 走了进去。'), '他推开门走了进去。');
		assert.equal(accept('他说：', ' “走吧。”'), '他说：“走吧。”');
	});

	test('leading whitespace is dropped mid-line; a full-width indent is kept at a line start', () => {
		assert.deepEqual(run('  了一句话就走了，留下我们面面相觑。', '他说'), ok('了一句话就走了，留下我们面面相觑。'));
		assert.deepEqual(run('\n　　第二天，雾还没有散。', '上一段。\n'), ok('　　第二天，雾还没有散。'));
	});

	test('the cursor marker is removed if the model repeats it', () => {
		assert.deepEqual(run(`${CURSOR}他推开门，走了进去。屋里`), ok('他推开门，走了进去。'));
	});
});
