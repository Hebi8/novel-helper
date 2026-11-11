import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSse, type SseEvent } from '../llm/sse';

function body(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
			}
			controller.close();
		},
	});
}

async function collect(chunks: Array<string | Uint8Array>): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	for await (const event of readSse(body(chunks))) {
		events.push(event);
	}
	return events;
}

describe('readSse', () => {
	test('events, names, comments and multi-line data', async () => {
		assert.deepEqual(await collect([': ping\n\nevent: a\ndata: 1\n\ndata: x\ndata: y\n\n']), [
			{ event: 'a', data: '1' },
			{ event: undefined, data: 'x\ny' },
		]);
	});

	test('line breaks split across chunks, including CRLF split between \\r and \\n', async () => {
		assert.deepEqual(await collect(['data: 1\r', '\n\r\n', 'da', 'ta: 2\n', '\n']), [
			{ event: undefined, data: '1' },
			{ event: undefined, data: '2' },
		]);
	});

	test('a multi-byte character split across chunks', async () => {
		const bytes = new TextEncoder().encode('data: 雾港\n\n');
		assert.deepEqual(await collect([bytes.subarray(0, 8), bytes.subarray(8)]), [{ event: undefined, data: '雾港' }]);
	});

	test('a last event without the closing blank line is still delivered', async () => {
		assert.deepEqual(await collect(['data: [DONE]']), [{ event: undefined, data: '[DONE]' }]);
	});

	test('no space after the colon', async () => {
		assert.deepEqual(await collect(['data:{"a":1}\n\n']), [{ event: undefined, data: '{"a":1}' }]);
	});
});
