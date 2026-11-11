import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { after, describe, test } from 'node:test';
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
		stable: '稳定部分',
		dynamic: '变化部分',
		maxTokens: 300,
		maxTokensField: preset.maxTokensField,
		extraBody: preset.extraBody,
		timeoutMs: 5000,
		...overrides,
	};
}

function options(overrides: Partial<CompletionOptions> = {}): CompletionOptions {
	return { signal: new AbortController().signal, before: '雨停了。', after: '', maxChars: 60, ...overrides };
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
		assert.deepEqual(body.messages, [
			{
				role: 'user',
				content: [
					{ type: 'text', text: '稳定部分', cache_control: { type: 'ephemeral' } },
					{ type: 'text', text: '变化部分' },
				],
			},
		]);
		assert.equal('temperature' in body, false);
	});

	test('without a stable part the breakpoint goes on the system prompt', () => {
		const { body } = buildHttpRequest(request('anthropic', 'https://api.anthropic.com', { stable: '' }));
		assert.deepEqual(body.system, [{ type: 'text', text: '系统', cache_control: { type: 'ephemeral' } }]);
		assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: '变化部分' }] }]);
	});

	test('streams text deltas into one sentence', async () => {
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
		assert.deepEqual(openai.body.messages, [
			{ role: 'system', content: '系统' },
			{ role: 'user', content: '稳定部分\n\n变化部分' },
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
	test('closes the connection as soon as the first sentence is complete', async () => {
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

describe('redact', () => {
	test('removes the key and key-shaped strings', () => {
		assert.equal(redact(`bad key ${KEY}!`, KEY), 'bad key ***!');
		assert.equal(redact('Incorrect API key provided: sk-proj-****abcd'), 'Incorrect API key provided: sk-***');
		assert.equal(redact('key=AIzaSyA1234567890abcdef'), 'key=AIza***');
	});
});
