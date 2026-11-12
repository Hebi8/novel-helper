import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildContext } from '../core/context';
import { Library } from '../core/library';
import { renderReport, renderUsage, type RunRecord, type Translate } from '../core/report';
import { type Ledger, record as recordUsage, usageKey } from '../core/usage';
import { buildHttpRequest } from '../llm/client';
import { PROVIDERS } from '../llm/providers';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));
const KEY = 'sk-ant-secret-0123456789';

function record(): RunRecord {
	const lib = new Library();
	lib.setLore('设定/文风.md', '---\nalways: true\n---\n短句。');
	lib.setLore('人物/张三.md', '---\naliases: [三哥]\ntype: 人物\n---\n张三会写 ```代码```');
	lib.setLore('人物/李四.md', `${'长'.repeat(50)}`);
	const { prompt, trace } = buildContext({
		documentPath: '正文/第2章.md',
		before: '李四来了。三哥说',
		after: '',
		maxChars: 100,
		entries: lib.entries(),
		matcher: lib.matcher(),
		levels: [
			{ name: '全书', book: true, outline: { path: '大纲/全书.md', content: '全书的大纲。' } },
			{ name: '第一卷', book: false },
		],
		outline: { path: '大纲/第2章.md', content: '张三登场' },
		previous: [{ path: '正文/第1章.md', text: '第一章结尾。' }],
		limits: {
			beforeChars: 100,
			afterChars: 20,
			alwaysChars: 100,
			matchedChars: 40,
			entryChars: 30,
			bookOutlineChars: 100,
			levelOutlineChars: 100,
			outlineChars: 100,
			nextNodeChars: 100,
			previousChapterChars: 100,
		},
	});
	const preset = PROVIDERS.anthropic;
	const { url, body } = buildHttpRequest({
		protocol: preset.protocol,
		baseUrl: preset.baseUrl,
		apiKey: KEY,
		model: preset.defaultModel,
		maxTokens: 300,
		maxTokensField: preset.maxTokensField,
		extraBody: preset.extraBody,
		timeoutMs: 1000,
		usageWaitMs: 0,
		...prompt,
	});
	return {
		time: new Date(2026, 10, 11, 23, 5, 9),
		document: '正文/第2章.md',
		line: 3,
		trigger: 'auto',
		provider: 'anthropic',
		model: preset.defaultModel,
		trace,
		prompt,
		request: { url, body },
		outcome: { status: 'ok', text: '「走吧。」', raw: '「走吧。」他说。', stoppedEarly: true, firstTokenMs: 310, totalMs: 520 },
	};
}

describe('renderReport', () => {
	test('lists entries, what was left out, chapters, the prompt and the reply', () => {
		const report = renderReport(record(), t);
		assert.match(report, /\| Time \| 2026-11-11 23:05:09 \|/);
		assert.match(report, /\| File \| 正文\/第2章\.md, line 3 \|/);
		assert.match(report, /first text after 310 ms, 520 ms in total \(stopped once the ghost text was complete\)/);
		assert.match(report, /\| 文风 \|  \| always on \| 8 \| body \|/);
		assert.match(report, /\| 张三 \| 人物 \| 「三哥」×1; nearest 1 chars before the cursor; named in the outline \| 28 \| body \|/);
		assert.match(report, /## Left out: over budget \(1\)\n\n.*\n.*\n\| 李四 \|  \| 「李四」×1; nearest 6 chars before the cursor \| 39 \|/);
		assert.match(report, /- Outline of the whole book: 大纲\/全书\.md, 6 chars\n- Outline of 第一卷: none\n- Outline of this chapter: 大纲\/第2章\.md, 4 chars/);
		assert.match(report, /- 正文\/第1章\.md: ending \(no summary\), 6 chars/);
		assert.match(report, /POST https:\/\/api\.anthropic\.com\/v1\/messages/);
		assert.match(report, /"thinking": \{\n\s+"type": "disabled"\n\s+\}/);
		assert.match(report, /## Ghost text\n\n```text\n「走吧。」\n```/);
	});

	test('a chapter with a position on the outline: where it is, and the nodes that went in', () => {
		const run = record();
		run.trace.outline = undefined;
		run.trace.position = {
			kind: 'bridge',
			nodes: [
				{ title: '等门', path: '大纲/第2章.md', chars: 12, truncated: false },
				{ title: '收信', path: '大纲/第2章.md', chars: 800, truncated: true },
			],
		};
		const bridge = renderReport(run, t);
		assert.match(bridge, /- Position on the outline: on the way from 【等门】 to 【收信】\n {2}- Node 【等门】: 大纲\/第2章\.md, 12 chars\n {2}- Node 【收信】: 大纲\/第2章\.md, 800 \(cut\) chars\n/);
		assert.doesNotMatch(bridge, /Outline of this chapter/);
		run.trace.position = { kind: 'in', nodes: [run.trace.position.nodes[0]], next: { title: '收信', chars: 0, truncated: false } };
		assert.match(renderReport(run, t), /- Position on the outline: in 【等门】\n {2}- Node 【等门】: .*\n {2}- Next node 【收信】: , 0 chars\n/);
	});

	test('the prompt is shown cut at its cache breakpoints, with how much of it can be reused', () => {
		const report = renderReport(record(), t);
		const system = record().prompt.system.length;
		const user = record().prompt.user;
		assert.deepEqual(user.map((b) => b.cache), [true, true, false]);
		const total = system + user.reduce((n, b) => n + b.text.length, 0);
		assert.ok(report.includes(`${total} chars in all, ${total - user[2].text.length} of them before the last cache breakpoint`));
		assert.match(report, /### User message, part 1 of 3 \(cache breakpoint after it\)\n\n```text\n<上层大纲>/);
		assert.match(report, /### User message, part 2 of 3 \(cache breakpoint after it\)\n\n````text\n<本章涉及的资料>/);
		assert.match(report, /### User message, part 3 of 3\n\n```text\n<当前章节 文件="第2章">\n李四来了。三哥说⟨光标⟩/);
		assert.match(report, /- Names are searched in the text before the cursor that is sent\./);
	});

	test('tokens and cost: reported, estimated, unknown, unpriced, still waiting', () => {
		const section = (change: Partial<RunRecord>) => {
			const report = renderReport({ ...record(), ...change }, t);
			return report.slice(report.indexOf('## Tokens and cost'), report.indexOf('## Prompt'));
		};
		const rates = PROVIDERS.anthropic.pricing!.rates;
		const full = section({ usage: { input: 400, cacheRead: 6000, cacheWrite: 300, output: 20 }, rates });
		assert.match(full, /\| Input at full price \| 400 \|\n\| Input read from cache \| 6000 \|\n\| Input written to cache \| 300 \|\n\| Output \| 20 \|/);
		assert.match(full, /\| Estimated cost \| \$0\.000148 \|/, '(400×0.1 + 6000×0.01 + 300×0.125 + 20×0.5) / 1e6 = $0.0001475');
		assert.match(full, /\| Prices \| input 0\.1, cache read 0\.01, cache write 0\.125, output 0\.5 \(US dollars per million tokens\) \|/);

		const estimated = section({ usage: { input: 400, output: 9, outputEstimated: true }, rates });
		assert.match(estimated, /\| Input read from cache \| not reported \|/);
		assert.match(estimated, /\| Output \| about 9 \(estimated from the text received/);

		assert.match(section({ usage: { input: 400, output: 20 } }), /\| Estimated cost \| unknown: no price for this model/);
		assert.match(section({ usage: {} }), /Unknown: the connection was closed before the provider reported it\./);
		assert.match(section({}), /Waiting for the provider to report it\./);
		assert.match(section({ outcome: { ...record().outcome!, status: 'error' } }), /None: the request failed\./);
	});

	test('code fences survive backticks in the prompt', () => {
		const report = renderReport(record(), t);
		assert.match(report, /````text\n[\s\S]*张三会写 ```代码```[\s\S]*\n````/);
	});

	test('never contains the API key', () => {
		assert.ok(!renderReport(record(), t).includes(KEY));
	});

	test('before the first request', () => {
		assert.match(renderReport(undefined, t), /^# Nothing sent yet/);
	});
});

describe('renderUsage', () => {
	const now = new Date(2026, 10, 12, 9, 0, 0);
	const info = { dailyLimit: 0, current: 'anthropic · claude-haiku-5-5', rates: PROVIDERS.anthropic.pricing!.rates };

	test('today and this month, per provider and model, with what the numbers leave out', () => {
		const ledger: Ledger = {};
		recordUsage(ledger, '2026-11-12', 'anthropic/claude-haiku-5-5', { input: 400, cacheRead: 6000, cacheWrite: 300, output: 20 }, 0.0001475);
		recordUsage(ledger, '2026-11-12', 'anthropic/claude-haiku-5-5', {}, undefined);
		recordUsage(ledger, '2026-11-12', 'openaiCompatible/qwen', { input: 1000, output: 30, outputEstimated: true }, undefined);
		recordUsage(ledger, '2026-11-03', 'anthropic/claude-haiku-5-5', { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 }, 0.00015);
		recordUsage(ledger, '2026-10-31', 'anthropic/claude-haiku-5-5', { input: 9999, output: 9999 }, 9);
		const report = renderUsage(ledger, now, info, t);
		const today = report.slice(report.indexOf('## Today (2026-11-12)'), report.indexOf('## This month'));
		assert.match(today, /\| anthropic\/claude-haiku-5-5 \| 2 \| 400 \| 6000 \| 300 \| 20 \| \$0\.000148 \|/);
		assert.match(today, /\| openaiCompatible\/qwen \| 1 \| 1000 \| 0 \| 0 \| 30 \| \$0\.000000 \|/);
		assert.match(today, /\| Total \| 3 \| 1400 \| 6000 \| 300 \| 50 \| \$0\.000148 \|/);
		assert.match(today, /- 78% of the input tokens were read from cache\./);
		assert.match(today, /- 1 requests ended before the provider reported usage/);
		assert.match(today, /- 1 requests used a model with no known price/);
		assert.match(today, /- The output of 1 requests is estimated/);
		const month = report.slice(report.indexOf('## This month (2026-11)'), report.indexOf('## How this is counted'));
		assert.match(month, /\| anthropic\/claude-haiku-5-5 \| 3 \| 1400 \| 6000 \| 300 \| 120 \| \$0\.000298 \|/, 'October is not in it');
		assert.match(report, /- anthropic · claude-haiku-5-5: input 0\.1, cache read 0\.01, cache write 0\.125, output 0\.5 \(US dollars per million tokens\)\./);
		assert.match(report, /- Daily limit: none\./);
	});

	test('requests that find the position on the outline have a row of their own', () => {
		const ledger: Ledger = {};
		recordUsage(ledger, '2026-11-12', usageKey('anthropic', 'claude-haiku-5-5'), { input: 400, output: 20 }, 0.0001);
		recordUsage(ledger, '2026-11-12', usageKey('anthropic', 'claude-haiku-5-5', 'position'), { input: 900, output: 2 }, 0.00009);
		const report = renderUsage(ledger, now, info, t);
		assert.match(report, /\| anthropic\/claude-haiku-5-5 \| 1 \| 400 \| 0 \| 0 \| 20 \| \$0\.000100 \|\n\| anthropic\/claude-haiku-5-5 · outline position \| 1 \| 900 \| 0 \| 0 \| 2 \| \$0\.000090 \|\n\| Total \| 2 \| 1300 /);
	});

	test('nothing yet; a model without a price; a daily limit', () => {
		const report = renderUsage({}, now, { dailyLimit: 0.5, current: 'openaiCompatible · qwen' }, t);
		assert.match(report, /## Today \(2026-11-12\)\n\nNo requests\.\n/);
		assert.match(report, /- openaiCompatible · qwen: no known price, so no cost is counted\./);
		assert.match(report, /- Daily limit: \$0\.5000\. Once today's estimated cost reaches it, automatic requests stop until tomorrow; Alt\+\\ still works\./);
	});
});
