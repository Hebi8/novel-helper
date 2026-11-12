// Streams one continuation from Anthropic's Messages API or an OpenAI-compatible
// Chat Completions endpoint, and has the answer as soon as the text that will
// be shown is in. Never throws: failures come back as an outcome.

import type { PromptBlock } from '../core/context';
import { extractSuggestion, type Suggestion } from '../core/suggestion';
import { estimateTokens, type Usage } from '../core/usage';
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
	/** The user message in blocks; cache breakpoints go after the blocks marked `cache`. */
	user: PromptBlock[];
	maxTokens: number;
	/** OpenAI-compatible only: which field carries the output cap; undefined sends none. */
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
	/**
	 * OpenAI-compatible only: send the blocks as content parts with OpenAI's
	 * explicit cache breakpoints. Otherwise the message is one string and
	 * caching is left to the server.
	 */
	cacheBreakpoints?: boolean;
	/** Merged into the request body last; a `null` value removes the field. */
	extraBody: Record<string, unknown>;
	timeoutMs: number;
	/** How long a request that has given its ghost text stays open for its usage to arrive. */
	usageWaitMs: number;
}

export interface HttpRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export function buildHttpRequest(req: ModelRequest): HttpRequest {
	const base = req.baseUrl.replace(/\/+$/, '');
	// With nothing to mark in the user message, the system prompt is the reusable part.
	const system: PromptBlock = { text: req.system, cache: !req.user.some((block) => block.cache) };
	let request: HttpRequest;
	if (req.protocol === 'anthropic') {
		const block = ({ text, cache }: PromptBlock) => ({
			type: 'text',
			text,
			...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
		});
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
				system: [block(system)],
				messages: [{ role: 'user', content: req.user.map(block) }],
			},
		};
	} else {
		const part = ({ text, cache }: PromptBlock) => ({
			type: 'text',
			text,
			...(cache ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}),
		});
		request = {
			url: `${base}/chat/completions`,
			headers: {
				'content-type': 'application/json',
				...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
			},
			body: {
				model: req.model,
				stream: true,
				// Usage comes in one extra event at the end of the stream.
				stream_options: { include_usage: true },
				...(req.maxTokensField ? { [req.maxTokensField]: req.maxTokens } : {}),
				...(req.cacheBreakpoints ? { prompt_cache_options: { mode: 'explicit' } } : {}),
				messages: req.cacheBreakpoints
					? [
							{ role: 'system', content: [part(system)] },
							{ role: 'user', content: req.user.map(part) },
						]
					: [
							{ role: 'system', content: req.system },
							{ role: 'user', content: req.user.map((block) => block.text).join('') },
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

/** What one stream event carries. */
interface Part {
	text?: string;
	usage?: Usage;
	done?: boolean;
	/** The model ran into the output cap: its text stops mid-way. */
	cutOff?: boolean;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

/** Drops the fields the event did not carry, so they do not overwrite earlier ones. */
function known(usage: Usage): Usage {
	return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
}

/**
 * Anthropic: `message_start` carries the input side (`input_tokens` is what
 * was neither read from nor written to the cache); the output count there is
 * a placeholder, the real one comes with `message_delta` at the end.
 */
export function anthropicPart(event: SseEvent): Part {
	const json = JSON.parse(event.data);
	if (json.type === 'error') {
		throw new Error(json.error?.message ?? event.data);
	}
	if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
		return { text: json.delta.text };
	}
	if (json.type === 'message_start' && json.message?.usage) {
		const usage = json.message.usage;
		return {
			usage: known({
				input: count(usage.input_tokens),
				cacheRead: count(usage.cache_read_input_tokens),
				cacheWrite: count(usage.cache_creation_input_tokens),
			}),
		};
	}
	if (json.type === 'message_delta') {
		return { usage: known({ output: count(json.usage?.output_tokens) }), cutOff: json.delta?.stop_reason === 'max_tokens' };
	}
	return {};
}

/**
 * OpenAI-compatible: usage comes once, after the last text. `prompt_tokens`
 * is all of the input; cached tokens are in `prompt_tokens_details.cached_tokens`
 * (OpenAI, Gemini) or `prompt_cache_hit_tokens` (DeepSeek), tokens written to
 * the cache in `prompt_tokens_details.cache_write_tokens` (OpenAI).
 */
export function openaiPart(event: SseEvent): Part {
	if (event.data === '[DONE]') {
		return { done: true };
	}
	const json = JSON.parse(event.data);
	if (json.error) {
		throw new Error(json.error.message ?? JSON.stringify(json.error));
	}
	const part: Part = { cutOff: json.choices?.[0]?.finish_reason === 'length' };
	const content = json.choices?.[0]?.delta?.content;
	if (typeof content === 'string' && content) {
		part.text = content;
	}
	const prompt = count(json.usage?.prompt_tokens);
	if (prompt !== undefined) {
		const cacheRead = count(json.usage.prompt_cache_hit_tokens) ?? count(json.usage.prompt_tokens_details?.cached_tokens);
		const cacheWrite = count(json.usage.prompt_tokens_details?.cache_write_tokens);
		part.usage = known({
			input: prompt - (cacheRead ?? 0) - (cacheWrite ?? 0),
			cacheRead,
			cacheWrite,
			output: count(json.usage.completion_tokens),
		});
	}
	return part;
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
	const out = apiKey ? text.split(apiKey).join('***') : text;
	return out.replace(/sk-[A-Za-z0-9_*.-]{6,}/g, 'sk-***').replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza***');
}

export interface CompletionOutcome {
	status: 'ok' | 'empty' | 'meta' | 'cancelled' | 'error';
	/** The ghost text; empty unless status is `ok`. */
	text: string;
	/** Everything the model sent before the answer was settled. */
	raw: string;
	error?: string;
	/** True when the answer was settled before the stream ended, because the text had reached the length that is shown. */
	stoppedEarly: boolean;
	firstTokenMs?: number;
	totalMs: number;
}

export interface CompletionOptions {
	signal: AbortSignal;
	before: string;
	after: string;
	maxChars: number;
	/**
	 * Called once for every request the provider took or may have taken, after
	 * the connection is closed; not called when it refused the request or
	 * could not be reached.
	 * This can be after `complete` has returned: a request that has given its
	 * ghost text stays open for up to `usageWaitMs` so that the usage can
	 * arrive. Fields the provider never reported are left undefined.
	 */
	onUsage?(usage: Usage): void;
	/**
	 * Called once when the request is over and its connection, if it had
	 * one, is closed. Like `onUsage`, this can be after `complete` has
	 * returned; until then, aborting `signal` still closes the connection.
	 */
	onClose?(): void;
}

/**
 * Resolves as soon as the answer is settled: the text has reached the length
 * that is shown, the stream ended, the caller cancelled, or the request
 * failed. The connection can stay open a little longer, see `onClose`.
 */
export function complete(req: ModelRequest, options: CompletionOptions): Promise<CompletionOutcome> {
	return new Promise((resolve) => void run(req, options, resolve).finally(() => options.onClose?.()));
}

async function run(req: ModelRequest, options: CompletionOptions, resolve: (outcome: CompletionOutcome) => void): Promise<void> {
	const started = Date.now();
	/** The model's text up to the point the answer was settled. */
	let raw = '';
	/** All of the model's text, to estimate the output count from if it never arrives. */
	let received = '';
	let firstTokenMs: number | undefined;
	let cutOff = false;
	let settled = false;
	/** The provider took the request, so it may bill for it. */
	let answered = false;
	const usage: Usage = {};
	const settle = (status: CompletionOutcome['status'], text = '', error?: string, stoppedEarly = false): void => {
		if (!settled) {
			settled = true;
			resolve({ status, text, raw, error, stoppedEarly, firstTokenMs, totalMs: Date.now() - started });
		}
	};
	if (options.signal.aborted) {
		settle('cancelled');
		return;
	}

	const controller = new AbortController();
	let timedOut = false;
	// What each protocol still owes once the answer is settled: Anthropic the input side, OpenAI all of it.
	const hasUsage = () => (req.protocol === 'anthropic' ? usage.input !== undefined : usage.output !== undefined);
	let wait: ReturnType<typeof setTimeout> | undefined;
	// A cancelled request is closed at once, with whatever usage has come in by then.
	const onCancel = () => {
		settle('cancelled');
		controller.abort();
	};
	options.signal.addEventListener('abort', onCancel, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, req.timeoutMs);

	const judge = (final: boolean): Suggestion =>
		extractSuggestion(raw, { before: options.before, after: options.after, maxChars: options.maxChars, final, cutOff });
	const parse = req.protocol === 'anthropic' ? anthropicPart : openaiPart;

	try {
		const { url, headers, body } = buildHttpRequest(req);
		const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${errorMessage(await response.text())}`);
		}
		if (!response.body) {
			throw new Error('response has no body');
		}
		answered = true;
		for await (const event of readSse(response.body)) {
			const part = parse(event);
			Object.assign(usage, part.usage);
			cutOff ||= part.cutOff === true;
			received += part.text ?? '';
			if (settled) {
				// Only here for the usage.
				if (hasUsage()) {
					break;
				}
				continue;
			}
			if (part.done) {
				break;
			}
			if (!part.text) {
				continue;
			}
			firstTokenMs ??= Date.now() - started;
			raw += part.text;
			const result = judge(false);
			if (result.status !== 'pending') {
				settle(result.status, result.text, undefined, true);
				if (hasUsage() || req.usageWaitMs <= 0) {
					break;
				}
				// The ghost text is in but the usage is not: stay for it, not for long.
				wait = setTimeout(() => controller.abort(), req.usageWaitMs);
			}
		}
		if (!settled) {
			const result = judge(true);
			settle(result.status === 'pending' ? 'empty' : result.status, result.text);
		}
	} catch (error) {
		// A request this side closed while waiting for an answer may still have been taken.
		answered ||= controller.signal.aborted;
		// Once settled, the only errors left are from closing the connection.
		const message = timedOut ? `no complete answer within ${req.timeoutMs} ms` : describe(error);
		settle('error', '', redact(message, req.apiKey));
	} finally {
		clearTimeout(timer);
		clearTimeout(wait);
		options.signal.removeEventListener('abort', onCancel);
		// Closes the connection if the stream is still open.
		controller.abort();
	}
	if (!answered) {
		return;
	}
	if (usage.input !== undefined && usage.output === undefined) {
		usage.output = estimateTokens(received);
		usage.outputEstimated = true;
	}
	options.onUsage?.(usage);
}
