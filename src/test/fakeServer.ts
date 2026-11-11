// A local HTTP server that plays back scripted Server-Sent Events, for testing
// the model client without calling a real API.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Step = string | Buffer | { wait: number };

export interface Received {
	url: string;
	headers: http.IncomingHttpHeaders;
	body: Record<string, unknown>;
	/** Resolves when the response ends; `true` if the client went away before the server finished. */
	closed: Promise<boolean>;
}

export interface FakeServer {
	baseUrl: string;
	received: Received[];
	close(): Promise<void>;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fakeServer(
	respond: (res: http.ServerResponse, request: Received) => Promise<void> | void,
): Promise<FakeServer> {
	const received: Received[] = [];
	const server = http.createServer(async (req, res) => {
		let raw = '';
		for await (const chunk of req) {
			raw += chunk;
		}
		const closed = new Promise<boolean>((resolve) => res.on('close', () => resolve(!res.writableFinished)));
		const request: Received = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {}, closed };
		received.push(request);
		await respond(res, request);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		received,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Writes the steps as an event stream, stopping early if the client disconnects. */
export async function stream(res: http.ServerResponse, steps: Step[]): Promise<void> {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const step of steps) {
		if (res.destroyed) {
			return;
		}
		if (typeof step === 'object' && !Buffer.isBuffer(step)) {
			// Unref'd so a test that has finished does not wait for the rest of the script.
			await new Promise((resolve) => setTimeout(resolve, step.wait).unref());
		} else {
			res.write(step);
		}
	}
	res.end();
}

export function anthropicText(text: string): string {
	return `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
}

/** `message_start` reports 40 input tokens at full price, 900 read from cache and 300 written to it. */
export const ANTHROPIC_START =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],' +
	'"usage":{"input_tokens":40,"cache_creation_input_tokens":300,"cache_read_input_tokens":900,"output_tokens":1}}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
	'event: ping\ndata: {"type": "ping"}\n\n';

export const ANTHROPIC_END =
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n' +
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

export function openaiText(content: string): string {
	return `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

export const OPENAI_START = `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`;
export const OPENAI_END = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

/** The extra event `stream_options.include_usage` adds before `[DONE]`. */
export function openaiUsage(usage: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [], usage })}\n\n`;
}
