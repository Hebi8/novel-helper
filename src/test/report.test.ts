import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildContext } from '../core/context';
import { Library } from '../core/library';
import { renderReport, type RunRecord, type Translate } from '../core/report';
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
		entries: lib.entries(),
		matcher: lib.matcher(),
		outline: { path: '大纲/第2章.md', content: '张三登场' },
		previous: [{ path: '正文/第1章.md', text: '第一章结尾。' }],
		limits: {
			beforeChars: 100,
			afterChars: 20,
			scanChars: 100,
			alwaysChars: 100,
			matchedChars: 40,
			entryChars: 30,
			outlineChars: 100,
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
		assert.match(report, /first text after 310 ms, 520 ms in total \(stopped once the first sentence arrived\)/);
		assert.match(report, /\| 文风 \|  \| always on \| 3 \| body \|/);
		assert.match(report, /\| 张三 \| 人物 \| 「三哥」×1; nearest 1 chars before the cursor; named in the outline \| 13 \| body \|/);
		assert.match(report, /## Left out: over budget \(1\)\n\n.*\n.*\n\| 李四 \|  \| 「李四」×1; nearest 6 chars before the cursor \| 30 \|/);
		assert.match(report, /- Outline: 大纲\/第2章\.md, 4 chars/);
		assert.match(report, /- 正文\/第1章\.md: ending \(no summary\), 6 chars/);
		assert.match(report, /POST https:\/\/api\.anthropic\.com\/v1\/messages/);
		assert.match(report, /"thinking": \{\n\s+"type": "disabled"\n\s+\}/);
		assert.match(report, /## Ghost text\n\n```text\n「走吧。」\n```/);
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
