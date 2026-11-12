import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { after, describe, test } from 'node:test';
import type { Usage } from '../core/usage';
import { buildHttpRequest, complete, type CompletionOptions, type ModelRequest, redact } from '../llm/client';
import { PROVIDERS } from '../llm/providers';
import {
	ANTHROPIC_END,
	ANTHROPIC_START,
	anthropicText,
	fakeServer,
	OPENAI_END,
	OPENAI_START,
	openaiText,
	openaiUsage,
	sleep,
	stream,
} from './fakeServer';

const KEY = 'sk-test-0123456789abcdef';

function request(protocol: 'anthropic' | 'openai', baseUrl: string, overrides: Partial<ModelRequest> = {}): ModelRequest {
	const preset = protocol === 'anthropic' ? PROVIDERS.anthropic : PROVIDERS.openai;
	return {
		protocol,
		baseUrl,
		apiKey: KEY,
		model: preset.defaultModel,
		system: '系统',
		user: [
			{ text: '大纲\n\n', cache: true },
			{ text: '资料\n\n', cache: false },
			{ text: '第一段\n', cache: true },
			{ text: '第二段\n', cache: true },
			{ text: '正在写的一行', cache: false },
		],
		maxTokens: 300,
		maxTokensField: preset.maxTokensField,
		extraBody: preset.extraBody,
		timeoutMs: 5000,
		usageWaitMs: 0,
		...overrides,
	};
}

/** The limit is short, so that in the scripts below the second sentence runs over it. */
function options(overrides: Partial<CompletionOptions> = {}): CompletionOptions {
	return { signal: new AbortController().signal, before: '雨停了。', after: '', maxChars: 12, ...overrides };
}

const servers: Array<{ close(): Promise<void> }> = [];
after(async () => {
	await Promise.all(servers.map((s) => s.close()));
});

async function serve(respond: Parameters<typeof fakeServer>[0]) {
	const server = await fakeServer(respond);
	servers.push(server);
	return server;
}

describe('Anthropic Messages API', () => {
	test('request shape: headers, cache breakpoint, thinking off', () => {
		const { url, headers, body } = buildHttpRequest(request('anthropic', 'https://api.anthropic.com/'));
		assert.equal(url, 'https://api.anthropic.com/v1/messages');
		assert.equal(headers['x-api-key'], KEY);
		assert.equal(headers['anthropic-version'], '2026-10-21');
		assert.equal(body.model, 'claude-haiku-5-5');
		assert.equal(body.max_tokens, 300);
		assert.equal(body.stream, true);
		assert.deepEqual(body.thinking, { type: 'disabled' });
		assert.deepEqual(body.system, [{ type: 'text', text: '系统' }]);
		const cache_control = { type: 'ephemeral' };
		assert.deepEqual(body.messages, [
			{
				role: 'user',
				content: [
					{ type: 'text', text: '大纲\n\n', cache_control },
					{ type: 'text', text: '资料\n\n' },
					{ type: 'text', text: '第一段\n', cache_control },
					{ type: 'text', text: '第二段\n', cache_control },
					{ type: 'text', text: '正在写的一行' },
				],
			},
		]);
		assert.equal('temperature' in body, false);
		assert.equal('cache_control' in body, false, 'no automatic breakpoint: it would land on the line being written');
	});

	test('with nothing marked in the user message the breakpoint goes on the system prompt', () => {
		const user = [{ text: '正在写的一行', cache: false }];
		const { body } = buildHttpRequest(request('anthropic', 'https://api.anthropic.com', { user }));
		assert.deepEqual(body.system, [{ type: 'text', text: '系统', cache_control: { type: 'ephemeral' } }]);
		assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: '正在写的一行' }] }]);
	});

	test('streams text deltas into the ghost text', async () => {
		const server = await serve((res) =>
			stream(res, [ANTHROPIC_START, anthropicText('他推开'), anthropicText('门，走了进去。'), ANTHROPIC_END]),
		);
		const outcome = await complete(request('anthropic', server.baseUrl), options());
		assert.equal(outcome.status, 'ok');
		assert.equal(outcome.text, '他推开门，走了进去。');
		assert.equal(outcome.raw, '他推开门，走了进去。');
		assert.ok(outcome.firstTokenMs !== undefined);
		const [received] = server.received;
		assert.equal(received.url, '/v1/messages');
		assert.equal(received.headers['x-api-key'], KEY);
		assert.equal(received.headers['anthropic-version'], '2026-10-21');
		assert.deepEqual(received.body.thinking, { type: 'disabled' });
	});

	test('an error event mid-stream becomes an error outcome', async () => {
		const server = await serve((res) =>
			stream(res, [
				ANTHROPIC_START,
				anthropicText('他'),
				'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
			]),
		);
		const outcome = await complete(request('anthropic', server.baseUrl), options());
		assert.equal(outcome.status, 'error');
		assert.equal(outcome.error, 'Overloaded');
		assert.equal(outcome.raw, '他');
	});
});

describe('OpenAI-compatible Chat Completions', () => {
	test('request shape per preset', () => {
		const openai = buildHttpRequest(request('openai', 'https://api.openai.com/v1'));
		assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
		assert.equal(openai.headers.authorization, `Bearer ${KEY}`);
		assert.equal(openai.body.max_completion_tokens, 300);
		assert.equal('max_tokens' in openai.body, false);
		assert.equal(openai.body.reasoning_effort, 'none');
		assert.deepEqual(openai.body.stream_options, { include_usage: true });
		assert.equal('prompt_cache_options' in openai.body, false);
		assert.deepEqual(openai.body.messages, [
			{ role: 'system', content: '系统' },
			{ role: 'user', content: '大纲\n\n资料\n\n第一段\n第二段\n正在写的一行' },
		]);

		const deepseek = PROVIDERS.deepseek;
		const ds = buildHttpRequest(
			request('openai', deepseek.baseUrl, {
				model: deepseek.defaultModel,
				maxTokensField: deepseek.maxTokensField,
				extraBody: deepseek.extraBody,
			}),
		);
		assert.equal(ds.url, 'https://api.deepseek.com/chat/completions');
		assert.equal(ds.body.max_tokens, 300);
		assert.deepEqual(ds.body.thinking, { type: 'disabled' });

		const gemini = PROVIDERS.gemini;
		const g = buildHttpRequest(
			request('openai', gemini.baseUrl, { model: gemini.defaultModel, maxTokensField: undefined, extraBody: {} }),
		);
		assert.equal(g.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
		assert.equal('max_tokens' in g.body || 'max_completion_tokens' in g.body, false);
	});

	test('OpenAI from GPT-5.6 on: explicit cache breakpoints on content parts', () => {
		const { body } = buildHttpRequest(request('openai', 'https://api.openai.com/v1', { cacheBreakpoints: true }));
		const prompt_cache_breakpoint = { mode: 'explicit' };
		assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
		assert.deepEqual(body.messages, [
			{ role: 'system', content: [{ type: 'text', text: '系统' }] },
			{
				role: 'user',
				content: [
					{ type: 'text', text: '大纲\n\n', prompt_cache_breakpoint },
					{ type: 'text', text: '资料\n\n' },
					{ type: 'text', text: '第一段\n', prompt_cache_breakpoint },
					{ type: 'text', text: '第二段\n', prompt_cache_breakpoint },
					{ type: 'text', text: '正在写的一行' },
				],
			},
		]);
		assert.equal(PROVIDERS.openai.cacheBreakpoints, true);
		assert.deepEqual(
			[PROVIDERS.deepseek, PROVIDERS.gemini, PROVIDERS.openaiCompatible].map((p) => p.cacheBreakpoints),
			[undefined, undefined, undefined],
			'only OpenAI itself takes the markers',
		);
	});

	test('extra body fields are merged; null removes one', () => {
		const { body } = buildHttpRequest(
			request('openai', 'http://x/v1', { extraBody: { reasoning_effort: null, temperature: 0.8, stream: true } }),
		);
		assert.equal('reasoning_effort' in body, false);
		assert.equal(body.temperature, 0.8);
	});

	test('no key: no Authorization header', () => {
		const { headers } = buildHttpRequest(request('openai', 'http://localhost:11434/v1', { apiKey: undefined }));
		assert.equal('authorization' in headers, false);
	});

	test('streams deltas, skips comments, role chunks and reasoning, stops at [DONE]', async () => {
		const server = await serve((res) =>
			stream(res, [
				': keep-alive\n\n',
				OPENAI_START,
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '想一想' } }] })}\n\n`,
				openaiText('她笑了笑，'),
				openaiText('没有说话'),
				OPENAI_END,
			]),
		);
		const outcome = await complete(request('openai', `${server.baseUrl}/v1`), options());
		assert.deepEqual([outcome.status, outcome.text, outcome.raw], ['ok', '她笑了笑，没有说话', '她笑了笑，没有说话']);
		assert.equal(server.received[0].url, '/v1/chat/completions');
		assert.equal(server.received[0].headers.authorization, `Bearer ${KEY}`);
	});

	test('a Chinese character split across network chunks and CRLF line ends', async () => {
		const event = Buffer.from(openaiText('他推开门，走了进去。屋里很暗。').replace(/\n/g, '\r\n'));
		const cut = event.indexOf(Buffer.from('门')) + 1; // inside the 3-byte character
		const server = await serve((res) => stream(res, [event.subarray(0, cut), { wait: 30 }, event.subarray(cut), OPENAI_END]));
		const outcome = await complete(request('openai', server.baseUrl), options());
		assert.deepEqual([outcome.status, outcome.text], ['ok', '他推开门，走了进去。']);
	});
});

describe('stopping and failing', () => {
	test('within the limit the whole reply is the ghost text, paragraphs included', async () => {
		const server = await serve((res) => stream(res, [OPENAI_START, openaiText('他推开门。\n'), openaiText('\n屋里很暗，什么也看不见。'), OPENAI_END]));
		const outcome = await complete(request('openai', server.baseUrl), options({ maxChars: 100 }));
		assert.deepEqual([outcome.status, outcome.text, outcome.stoppedEarly], ['ok', '他推开门。\n\n屋里很暗，什么也看不见。', false]);
	});

	test('cut off by the output cap, as either protocol reports it: the ghost text ends at the last sentence end', async () => {
		const text = '他推开门。屋里很暗，什么';
		const anthropic = (reason: string) =>
			serve((res) => stream(res, [ANTHROPIC_START, anthropicText(text), ANTHROPIC_END.replace('end_turn', reason)]));
		const openai = (reason: string) =>
			serve((res) => stream(res, [OPENAI_START, openaiText(text), OPENAI_END.replace('"stop"', `"${reason}"`)]));
		const shown = async (protocol: 'anthropic' | 'openai', server: { baseUrl: string }) =>
			(await complete(request(protocol, server.baseUrl), options({ maxChars: 100 }))).text;
		assert.equal(await shown('anthropic', await anthropic('max_tokens')), '他推开门。');
		assert.equal(await shown('anthropic', await anthropic('end_turn')), text, 'the model stopped there by itself');
		assert.equal(await shown('openai', await openai('length')), '他推开门。');
		assert.equal(await shown('openai', await openai('stop')), text);
	});

	test('closes the connection as soon as the text is longer than the limit', async () => {
		const server = await serve((res) =>
			stream(res, [OPENAI_START, openaiText('他推开门，'), openaiText('走了进去。'), openaiText('屋里很'), { wait: 3000 }, openaiText('暗。'), OPENAI_END]),
		);
		const started = Date.now();
		const outcome = await complete(request('openai', server.baseUrl), options());
		assert.ok(Date.now() - started < 1500, 'did not wait for the rest of the stream');
		assert.deepEqual([outcome.status, outcome.text, outcome.stoppedEarly], ['ok', '他推开门，走了进去。', true]);
		assert.equal(await server.received[0].closed, true, 'the server saw the client go away');
	});

	test('cancelling (the user kept typing) aborts the request', async () => {
		const server = await serve((res) => stream(res, [OPENAI_START, openaiText('他推开门'), { wait: 3000 }, OPENAI_END]));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const started = Date.now();
		const outcome = await complete(request('openai', server.baseUrl), options({ signal: controller.signal }));
		assert.equal(outcome.status, 'cancelled');
		assert.ok(Date.now() - started < 1500);
		assert.equal(await server.received[0].closed, true);
	});

	test('cancelled before starting: nothing is sent', async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await complete(request('openai', 'http://127.0.0.1:9'), options({ signal: controller.signal }));
		assert.equal(outcome.status, 'cancelled');
	});

	test('an HTTP error becomes an outcome with the API message and no key', async () => {
		const server = await serve((res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}.`, type: 'invalid_request_error' } }));
		});
		const outcome = await complete(request('openai', server.baseUrl), options());
		assert.equal(outcome.status, 'error');
		assert.match(outcome.error!, /^HTTP 401: Incorrect API key provided: \*\*\*\.$/);
		assert.ok(!outcome.error!.includes(KEY));
	});

	test('a short key echoed back by a local server is removed too', async () => {
		const server = await serve((res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Incorrect API key: localpw' } }));
		});
		const outcome = await complete(request('openai', server.baseUrl, { apiKey: 'localpw' }), options());
		assert.equal(outcome.error, 'HTTP 401: Incorrect API key: ***');
	});

	test('a non-JSON error body is shown as text', async () => {
		const server = await serve((res) => {
			res.writeHead(502, { 'content-type': 'text/html' });
			res.end('<html>Bad gateway</html>');
		});
		const outcome = await complete(request('openai', server.baseUrl), options());
		assert.equal(outcome.error, 'HTTP 502: <html>Bad gateway</html>');
	});

	test('connection refused: error outcome, no exception', async () => {
		const probe = http.createServer();
		await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
		const { port } = probe.address() as { port: number };
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const outcome = await complete(request('openai', `http://127.0.0.1:${port}`), options());
		assert.equal(outcome.status, 'error');
		assert.match(outcome.error!, /fetch failed/);
	});

	test('no answer in time: error outcome', async () => {
		const server = await serve(async (res) => {
			await new Promise((resolve) => setTimeout(resolve, 2000).unref());
			res.end();
		});
		const outcome = await complete(request('openai', server.baseUrl, { timeoutMs: 200 }), options());
		assert.equal(outcome.status, 'error');
		assert.equal(outcome.error, 'no complete answer within 200 ms');
	});

	test('a preamble is dropped and the request stopped', async () => {
		const server = await serve((res) =>
			stream(res, [OPENAI_START, openaiText('好的，以下是续写：'), { wait: 3000 }, openaiText('他推开门。'), OPENAI_END]),
		);
		const outcome = await complete(request('openai', server.baseUrl), options());
		assert.deepEqual([outcome.status, outcome.text, outcome.stoppedEarly], ['meta', '', true]);
	});
});

/** Runs one request and returns its outcome with the usage reported for it (`null` if none was). */
async function run(req: ModelRequest, overrides: Partial<CompletionOptions> = {}) {
	let reported: Usage | null = null;
	let calls = 0;
	const done = new Promise<void>((resolve) => {
		overrides = {
			...overrides,
			onUsage(usage) {
				reported = usage;
				calls++;
				resolve();
			},
		};
	});
	const outcome = await complete(req, options(overrides));
	await Promise.race([done, sleep(800)]);
	return { outcome, usage: reported as Usage | null, calls };
}

describe('usage', () => {
	test('Anthropic, stream read to its end: input side from message_start, output from message_delta', async () => {
		const server = await serve((res) => stream(res, [ANTHROPIC_START, anthropicText('他推开门'), ANTHROPIC_END]));
		const { outcome, usage, calls } = await run(request('anthropic', server.baseUrl));
		assert.equal(outcome.text, '他推开门');
		assert.deepEqual(usage, { input: 40, cacheRead: 900, cacheWrite: 300, output: 12 });
		assert.equal(calls, 1);
	});

	test('Anthropic, closed once the ghost text is in: the input side is exact, the output an estimate', async () => {
		const server = await serve((res) =>
			stream(res, [ANTHROPIC_START, anthropicText('他推开门，走了进去。'), anthropicText('屋里很'), { wait: 3000 }, ANTHROPIC_END]),
		);
		const started = Date.now();
		const { outcome, usage } = await run(request('anthropic', server.baseUrl, { usageWaitMs: 2000 }));
		assert.ok(Date.now() - started < 1000, 'message_start was in: no waiting');
		assert.equal(outcome.stoppedEarly, true);
		assert.deepEqual(usage, { input: 40, cacheRead: 900, cacheWrite: 300, output: 13, outputEstimated: true });
		assert.equal(await server.received[0].closed, true);
	});

	test('Anthropic without cache fields: they stay unknown', async () => {
		const start = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n';
		const server = await serve((res) => stream(res, [start, anthropicText('好。'), ANTHROPIC_END]));
		const { usage } = await run(request('anthropic', server.baseUrl));
		assert.deepEqual(usage, { input: 25, output: 12 });
	});

	test('OpenAI: asks for usage and stays for it once the ghost text is in, without holding up the answer', async () => {
		const server = await serve((res) =>
			stream(res, [
				OPENAI_START,
				openaiText('他推开门，走了进去。'),
				openaiText('屋里很暗。'),
				{ wait: 300 },
				OPENAI_END.replace('data: [DONE]\n\n', ''),
				openaiUsage({
					prompt_tokens: 1240,
					completion_tokens: 17,
					prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 300 },
				}),
				'data: [DONE]\n\n',
			]),
		);
		const started = Date.now();
		let answeredAfter = 0;
		const usage = await new Promise<Usage>((resolve) => {
			void complete(request('openai', server.baseUrl, { usageWaitMs: 2000 }), options({ onUsage: resolve })).then((outcome) => {
				answeredAfter = Date.now() - started;
				assert.deepEqual([outcome.text, outcome.raw, outcome.stoppedEarly], ['他推开门，走了进去。', '他推开门，走了进去。屋里很暗。', true]);
			});
		});
		assert.ok(answeredAfter > 0 && answeredAfter < 250, `answered after ${answeredAfter} ms, before the rest of the stream`);
		assert.deepEqual(usage, { input: 40, cacheRead: 900, cacheWrite: 300, output: 17 });
		assert.deepEqual(server.received[0].body.stream_options, { include_usage: true });
	});

	test('OpenAI: the usage never comes within the wait: reported as unknown, connection closed', async () => {
		const server = await serve((res) =>
			stream(res, [OPENAI_START, openaiText('他推开门。'), openaiText('屋里很暗，什么也看不见'), { wait: 3000 }, OPENAI_END]),
		);
		const started = Date.now();
		const { outcome, usage } = await run(request('openai', server.baseUrl, { usageWaitMs: 200 }));
		assert.equal(outcome.text, '他推开门。');
		assert.deepEqual(usage, {});
		assert.ok(Date.now() - started < 1000);
		assert.equal(await server.received[0].closed, true);
	});

	test('DeepSeek field names; a server that reports no cache fields', async () => {
		const deepseek = await serve((res) =>
			stream(res, [
				openaiText('好'),
				openaiUsage({ prompt_tokens: 1000, completion_tokens: 3, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }),
				'data: [DONE]\n\n',
			]),
		);
		assert.deepEqual((await run(request('openai', deepseek.baseUrl))).usage, { input: 200, cacheRead: 800, output: 3 });

		const local = await serve((res) =>
			stream(res, [openaiText('好'), openaiUsage({ prompt_tokens: 1000, completion_tokens: 3 }), 'data: [DONE]\n\n']),
		);
		assert.deepEqual((await run(request('openai', local.baseUrl))).usage, { input: 1000, output: 3 });
	});

	test('cancelled: closed at once, with the usage that had come in by then', async () => {
		const anthropic = await serve((res) => stream(res, [ANTHROPIC_START, anthropicText('他推开'), { wait: 3000 }, ANTHROPIC_END]));
		let controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const first = await run(request('anthropic', anthropic.baseUrl, { usageWaitMs: 2000 }), { signal: controller.signal });
		assert.equal(first.outcome.status, 'cancelled');
		assert.deepEqual(first.usage, { input: 40, cacheRead: 900, cacheWrite: 300, output: 3, outputEstimated: true });

		const openai = await serve((res) =>
			stream(res, [OPENAI_START, openaiText('他推开'), { wait: 3000 }, openaiUsage({ prompt_tokens: 500, completion_tokens: 4 }), 'data: [DONE]\n\n']),
		);
		controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		const second = await run(request('openai', openai.baseUrl, { usageWaitMs: 2000 }), { signal: controller.signal });
		assert.equal(second.outcome.status, 'cancelled');
		assert.deepEqual(second.usage, {}, 'this protocol reports at the end: unknown');
		assert.ok(Date.now() - started < 500, 'no waiting');
		assert.equal(await openai.received[0].closed, true);
	});

	test('a request the provider refused, or that never went out, reports nothing', async () => {
		const server = await serve((res) => {
			res.writeHead(429, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
		});
		const refused = await run(request('anthropic', server.baseUrl, { usageWaitMs: 100 }));
		assert.equal(refused.outcome.status, 'error');
		assert.deepEqual([refused.usage, refused.calls], [null, 0]);

		const controller = new AbortController();
		controller.abort();
		const unsent = await run(request('openai', 'http://127.0.0.1:9'), { signal: controller.signal });
		assert.deepEqual([unsent.outcome.status, unsent.calls], ['cancelled', 0]);
	});
});

describe('when the connection closes', () => {
	test('the ghost text is in, the connection still open for the usage: cancelling then closes it at once', async () => {
		const server = await serve((res) =>
			stream(res, [
				OPENAI_START,
				openaiText('他推开门，走了进去。'),
				openaiText('屋里很暗。'),
				{ wait: 3000 },
				openaiUsage({ prompt_tokens: 500, completion_tokens: 17 }),
				'data: [DONE]\n\n',
			]),
		);
		const controller = new AbortController();
		let closedAt: number | undefined;
		let usage: Usage | undefined;
		const outcome = await complete(
			request('openai', server.baseUrl, { usageWaitMs: 2000 }),
			options({ signal: controller.signal, onUsage: (u) => (usage = u), onClose: () => (closedAt = Date.now()) }),
		);
		assert.equal(outcome.text, '他推开门，走了进去。');
		await sleep(50);
		assert.equal(closedAt, undefined, 'the ghost text is ready, the connection is not closed yet');
		// The writer types on, or switches ghost text off.
		const cancelled = Date.now();
		controller.abort();
		assert.equal(await server.received[0].closed, true, 'the server sees the client go');
		await sleep(20);
		assert.ok(closedAt !== undefined && closedAt - cancelled < 200, 'closed on cancelling, not when the wait for usage runs out');
		assert.deepEqual(usage, {}, 'counted as a request whose usage is unknown');
	});

	test('onClose comes once however the request ends', async () => {
		const count = async (req: ModelRequest, signal = new AbortController().signal) => {
			let closes = 0;
			const outcome = await complete(req, options({ signal, onClose: () => closes++ }));
			await sleep(150);
			return [outcome.status, closes];
		};
		const whole = await serve((res) => stream(res, [ANTHROPIC_START, anthropicText('好。'), ANTHROPIC_END]));
		assert.deepEqual(await count(request('anthropic', whole.baseUrl)), ['ok', 1]);
		const waited = await serve((res) => stream(res, [OPENAI_START, openaiText('他推开门。'), openaiText('屋里很暗，什么也看不见'), { wait: 3000 }, OPENAI_END]));
		assert.deepEqual(await count(request('openai', waited.baseUrl, { usageWaitMs: 50 })), ['ok', 1]);
		const refused = await serve((res) => {
			res.writeHead(500);
			res.end('no');
		});
		assert.deepEqual(await count(request('openai', refused.baseUrl)), ['error', 1]);
		const aborted = new AbortController();
		aborted.abort();
		assert.deepEqual(await count(request('openai', 'http://127.0.0.1:9'), aborted.signal), ['cancelled', 1]);
	});
});

describe('redact', () => {
	test('removes the key and key-shaped strings', () => {
		assert.equal(redact(`bad key ${KEY}!`, KEY), 'bad key ***!');
		assert.equal(redact('Incorrect API key provided: sk-proj-****abcd'), 'Incorrect API key provided: sk-***');
		assert.equal(redact('key=AIzaSyA1234567890abcdef'), 'key=AIza***');
	});
});
