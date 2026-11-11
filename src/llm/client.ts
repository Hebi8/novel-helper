// Streams one continuation from Anthropic's Messages API or an OpenAI-compatible
// Chat Completions endpoint, and stops the request as soon as the first
// sentence is complete. Never throws: failures come back as an outcome.

import { extractSuggestion, type Suggestion } from '../core/suggestion';
import { readSse, type SseEvent } from './sse';

export type Protocol = 'anthropic' | 'openai';

/** Sent as `anthropic-version`; the current API version as of 2026-11. */
export const ANTHROPIC_VERSION = '2026-10-21';

export interface ModelRequest {
	protocol: Protocol;
	/** `https://api.anthropic.com` for Anthropic; up to `/v1` for OpenAI-compatible endpoints. */
	baseUrl: string;
	apiKey?: string;
	model: string;
	system: string;
	stable: string;
	dynamic: string;
	maxTokens: number;
	/** OpenAI-compatible only: which field carries the output cap; undefined sends none. */
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
	/** Merged into the request body last; a `null` value removes the field. */
	extraBody: Record<string, unknown>;
	timeoutMs: number;
}

export interface HttpRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export function buildHttpRequest(req: ModelRequest): HttpRequest {
	const base = req.baseUrl.replace(/\/+$/, '');
	let request: HttpRequest;
	if (req.protocol === 'anthropic') {
		// Cache breakpoint after the part that stays the same within a chapter.
		const cache = { cache_control: { type: 'ephemeral' } };
		request = {
			url: `${base}/v1/messages`,
			headers: {
				'content-type': 'application/json',
				'anthropic-version': ANTHROPIC_VERSION,
				...(req.apiKey ? { 'x-api-key': req.apiKey } : {}),
			},
			body: {
				model: req.model,
				max_tokens: req.maxTokens,
				stream: true,
				system: [{ type: 'text', text: req.system, ...(req.stable ? {} : cache) }],
				messages: [
					{
						role: 'user',
						content: [
							...(req.stable ? [{ type: 'text', text: req.stable, ...cache }] : []),
							{ type: 'text', text: req.dynamic },
						],
					},
				],
			},
		};
	} else {
		request = {
			url: `${base}/chat/completions`,
			headers: {
				'content-type': 'application/json',
				...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
			},
			body: {
				model: req.model,
				stream: true,
				...(req.maxTokensField ? { [req.maxTokensField]: req.maxTokens } : {}),
				messages: [
					{ role: 'system', content: req.system },
					{ role: 'user', content: req.stable ? `${req.stable}\n\n${req.dynamic}` : req.dynamic },
				],
			},
		};
	}
	for (const [key, value] of Object.entries(req.extraBody)) {
		if (value === null) {
			delete request.body[key];
		} else {
			request.body[key] = value;
		}
	}
	return request;
}

const DONE = Symbol('done');

function anthropicDelta(event: SseEvent): string | undefined {
	const json = JSON.parse(event.data);
	if (json.type === 'error') {
		throw new Error(json.error?.message ?? event.data);
	}
	if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
		return json.delta.text;
	}
	return undefined;
}

function openaiDelta(event: SseEvent): string | undefined | typeof DONE {
	if (event.data === '[DONE]') {
		return DONE;
	}
	const json = JSON.parse(event.data);
	if (json.error) {
		throw new Error(json.error.message ?? JSON.stringify(json.error));
	}
	const content = json.choices?.[0]?.delta?.content;
	return typeof content === 'string' ? content : undefined;
}

function errorMessage(body: string): string {
	try {
		const json = JSON.parse(body);
		const message = json?.error?.message ?? json?.message ?? json?.error;
		if (typeof message === 'string') {
			return message;
		}
	} catch {
		// Not JSON: show the start of the body as is.
	}
	return body.slice(0, 300);
}

function describe(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = error.cause instanceof Error ? error.cause.message : error.cause;
	return cause ? `${error.message} (${cause})` : error.message;
}

/** Removes the key, and anything shaped like one, from text that will be shown or logged. */
export function redact(text: string, apiKey?: string): string {
	let out = apiKey && apiKey.length >= 8 ? text.split(apiKey).join('***') : text;
	out = out.replace(/sk-[A-Za-z0-9_*.-]{6,}/g, 'sk-***').replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza***');
	return out;
}

export interface CompletionOutcome {
	status: 'ok' | 'empty' | 'meta' | 'cancelled' | 'error';
	/** The ghost text; empty unless status is `ok`. */
	text: string;
	/** Everything the model sent before the request ended. */
	raw: string;
	error?: string;
	/** True when the request was closed early because a full sentence had arrived. */
	stoppedEarly: boolean;
	firstTokenMs?: number;
	totalMs: number;
}

export interface CompletionOptions {
	signal: AbortSignal;
	before: string;
	after: string;
	maxChars: number;
}

export async function complete(req: ModelRequest, options: CompletionOptions): Promise<CompletionOutcome> {
	const started = Date.now();
	let raw = '';
	let firstTokenMs: number | undefined;
	let stoppedEarly = false;
	const finish = (status: CompletionOutcome['status'], text = '', error?: string): CompletionOutcome => ({
		status, text, raw, error, stoppedEarly, firstTokenMs, totalMs: Date.now() - started,
	});
	if (options.signal.aborted) {
		return finish('cancelled');
	}

	const controller = new AbortController();
	let cancelled = false;
	let timedOut = false;
	const onCancel = () => {
		cancelled = true;
		controller.abort();
	};
	options.signal.addEventListener('abort', onCancel, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, req.timeoutMs);

	const judge = (final: boolean): Suggestion =>
		extractSuggestion(raw, { before: options.before, after: options.after, maxChars: options.maxChars, final });
	const parse = req.protocol === 'anthropic' ? anthropicDelta : openaiDelta;

	try {
		const { url, headers, body } = buildHttpRequest(req);
		const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${errorMessage(await response.text())}`);
		}
		if (!response.body) {
			throw new Error('response has no body');
		}
		let result: Suggestion = { status: 'pending', text: '' };
		for await (const event of readSse(response.body)) {
			const delta = parse(event);
			if (delta === DONE) {
				break;
			}
			if (!delta) {
				continue;
			}
			firstTokenMs ??= Date.now() - started;
			raw += delta;
			result = judge(false);
			if (result.status !== 'pending') {
				stoppedEarly = true;
				break;
			}
		}
		if (result.status === 'pending') {
			result = judge(true);
		}
		return finish(result.status === 'pending' ? 'empty' : result.status, result.text);
	} catch (error) {
		if (cancelled) {
			return finish('cancelled');
		}
		const message = timedOut ? `no complete answer within ${req.timeoutMs} ms` : describe(error);
		return finish('error', '', redact(message, req.apiKey));
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener('abort', onCancel);
		// Closes the connection if the stream is still open (early stop or error).
		controller.abort();
	}
}
