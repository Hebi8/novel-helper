// The panel and report Markdown reader: what becomes structure, and what stays text.

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseInline, parseMarkdown } from '../core/markdown';
import { renderUsage } from '../core/report';
import { Markdown } from '../renderer/assistant/Markdown';
import { translateReport } from '../renderer/strings';

describe('inline text', () => {
	test('code, strong, emphasis and strike-through, also right next to Chinese', () => {
		assert.deepEqual(parseInline('把`正文/第1章.md`的**第一句**改了，*只*改这~~两~~一句'), [
			'把',
			{ type: 'code', text: '正文/第1章.md' },
			'的',
			{ type: 'strong', children: ['第一句'] },
			'改了，',
			{ type: 'em', children: ['只'] },
			'改这',
			{ type: 'del', children: ['两'] },
			'一句',
		]);
		assert.deepEqual(parseInline('**加粗里有`代码`**'), [{ type: 'strong', children: ['加粗里有', { type: 'code', text: '代码' }] }]);
	});

	test('marks that mark nothing stay as they are', () => {
		assert.deepEqual(parseInline('2 * 3 * 4，snake_case_name，a ** b'), ['2 * 3 * 4，snake_case_name，a ** b']);
		assert.deepEqual(parseInline('\\*不是强调\\*'), ['*不是强调*']);
		assert.deepEqual(parseInline('`` a`b ``'), [{ type: 'code', text: 'a`b' }]);
	});

	test('links go to the web or stay text; pictures are not loaded', () => {
		assert.deepEqual(parseInline('看[文档](https://example.com/a "标题")。'), [
			'看',
			{ type: 'link', href: 'https://example.com/a', children: ['文档'] },
			'。',
		]);
		assert.deepEqual(parseInline('[点我](javascript:alert(1))'), ['[点我](javascript:alert(1))']);
		assert.deepEqual(parseInline('[本地](file:///etc/passwd) [命令](command:workbench.action.terminal.new)'), [
			'[本地](file:///etc/passwd) [命令](command:workbench.action.terminal.new)',
		]);
		assert.deepEqual(parseInline('![图](https://example.com/x.png)'), [{ type: 'link', href: 'https://example.com/x.png', children: ['图'] }]);
		assert.deepEqual(parseInline('见 https://example.com/a?b=1。后面'), [
			'见 ',
			{ type: 'link', href: 'https://example.com/a?b=1', children: ['https://example.com/a?b=1'] },
			'。后面',
		]);
	});

	test('HTML stays text', () => {
		assert.deepEqual(parseInline('<img src=x onerror=alert(1)> <b>粗</b>'), ['<img src=x onerror=alert(1)> <b>粗</b>']);
		assert.deepEqual(parseMarkdown('<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>'), [
			{ type: 'paragraph', children: ['<script>alert(1)</script>'] },
			{ type: 'paragraph', children: ['<iframe src="', { type: 'link', href: 'https://example.com', children: ['https://example.com'] }, '"></iframe>'] },
		]);
	});
});

describe('blocks', () => {
	test('headings, paragraphs with their line breaks, rules', () => {
		assert.deepEqual(parseMarkdown('# 改了什么\n\n第一行\n第二行\n\n---\n### 小标题 ###'), [
			{ type: 'heading', level: 1, children: ['改了什么'] },
			{ type: 'paragraph', children: ['第一行\n第二行'] },
			{ type: 'rule' },
			{ type: 'heading', level: 3, children: ['小标题'] },
		]);
	});

	test('code blocks keep their text as it is; one that is still being written runs to the end', () => {
		assert.deepEqual(parseMarkdown('```md\n# 不是标题\n**不是粗体**\n```\n后面'), [
			{ type: 'code', language: 'md', text: '# 不是标题\n**不是粗体**' },
			{ type: 'paragraph', children: ['后面'] },
		]);
		assert.deepEqual(parseMarkdown('前面\n```\n写到一半'), [
			{ type: 'paragraph', children: ['前面'] },
			{ type: 'code', language: '', text: '写到一半' },
		]);
	});

	test('lists: bullets, numbers, text that goes on, lists in lists', () => {
		assert.deepEqual(parseMarkdown('- 原句：长\n- 新句：短\n  接着说\n\n后面'), [
			{
				type: 'list',
				ordered: false,
				start: 1,
				items: [[{ type: 'paragraph', children: ['原句：长'] }], [{ type: 'paragraph', children: ['新句：短\n接着说'] }]],
			},
			{ type: 'paragraph', children: ['后面'] },
		]);
		assert.deepEqual(parseMarkdown('3. 第三\n4. 第四\n   - 里面\n   - 还有'), [
			{
				type: 'list',
				ordered: true,
				start: 3,
				items: [
					[{ type: 'paragraph', children: ['第三'] }],
					[
						{ type: 'paragraph', children: ['第四'] },
						{
							type: 'list',
							ordered: false,
							start: 1,
							items: [[{ type: 'paragraph', children: ['里面'] }], [{ type: 'paragraph', children: ['还有'] }]],
						},
					],
				],
			},
		]);
		// Items with blank lines between them are still one list.
		const loose = parseMarkdown('1. 一\n\n2. 二\n\n不是列表');
		assert.equal(loose.length, 2);
		assert.equal(loose[0].type === 'list' && loose[0].items.length, 2);
	});

	test('quotes hold blocks', () => {
		assert.deepEqual(parseMarkdown('> 清晨，雾从海面漫上来。\n> - 一\n\n外面'), [
			{
				type: 'quote',
				children: [
					{ type: 'paragraph', children: ['清晨，雾从海面漫上来。'] },
					{ type: 'list', ordered: false, start: 1, items: [[{ type: 'paragraph', children: ['一'] }]] },
				],
			},
			{ type: 'paragraph', children: ['外面'] },
		]);
	});

	test('tables and column alignment', () => {
		assert.deepEqual(parseMarkdown('| 文件 | 改动 | 居中 | 数字 |\n|---|:--|:-:|---:|\n| `第1章.md` | 首句 \\| 标点 | **是** | 42 |\n\n后面'), [
			{
				type: 'table',
				head: [['文件'], ['改动'], ['居中'], ['数字']],
				align: [undefined, 'left', 'center', 'right'],
				rows: [[[{ type: 'code', text: '第1章.md' }], ['首句 | 标点'], [{ type: 'strong', children: ['是'] }], ['42']]],
			},
			{ type: 'paragraph', children: ['后面'] },
		]);
		assert.deepEqual(parseMarkdown('| | |\n|---|---|\n| 时间 | 2026-04-01 |'), [
			{
				type: 'table',
				head: [[], []],
				rows: [[['时间'], ['2026-04-01']]],
			},
		]);
		assert.deepEqual(parseMarkdown('a | b'), [{ type: 'paragraph', children: ['a | b'] }]);
	});

	test('Markdown component renders report headings, headless tables, aligned columns, lists, code blocks, and bold', () => {
		const headless = renderToStaticMarkup(
			createElement(Markdown, {
				headingOffset: 0,
				className: 'report-markdown',
				text: '# 标题\n\n| | |\n|---|---|\n| 模型 | **Sonnet** |\n\n```json\n{"a": 1}\n```',
			}),
		);
		assert.match(headless, /^<div class="assistant-markdown report-markdown"><h1>标题<\/h1>/);
		assert.ok(!headless.includes('<thead>'));
		assert.match(headless, /<td><strong>Sonnet<\/strong><\/td>/);
		assert.match(headless, /<pre><code>\{&quot;a&quot;: 1\}<\/code><\/pre>/);

		const usageMd = renderUsage(
			{
				'2026-04-01': {
					'anthropic:claude-sonnet-4-6': {
						requests: 2,
						input: 100,
						cacheRead: 50,
						cacheWrite: 0,
						output: 30,
						cost: 0.001,
						unpriced: 0,
						unknown: 0,
						estimated: 0,
					},
				},
			},
			new Date(2026, 3, 1, 12, 0, 0),
			{ dailyLimit: 1, current: 'anthropic · claude-sonnet-4-6', rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
			translateReport,
		);
		const usageHtml = renderToStaticMarkup(createElement(Markdown, { headingOffset: 0, text: usageMd }));
		assert.match(usageHtml, /<h1>用量和估算花费<\/h1>/);
		assert.match(usageHtml, /<h2>今天（2026-04-01）<\/h2>/);
		assert.match(usageHtml, /<th style="text-align:right">请求数<\/th>/);
		assert.match(usageHtml, /<td style="text-align:right">2<\/td>/);
		assert.match(usageHtml, /<ul><li>/);
	});
});
