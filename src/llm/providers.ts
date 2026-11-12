// Built-in provider presets. Model ids and the fields that switch thinking off
// were checked against each provider's documentation on 2026-11-11:
//   Anthropic: claude-haiku-5-5 thinks by default; `thinking: {type: "disabled"}`
//     is accepted at its default effort.
//   OpenAI: gpt-6-luna is a reasoning model and supports `reasoning_effort: "none"`;
//     its output cap is `max_completion_tokens`.
//   DeepSeek: deepseek-flash thinks by default; `thinking: {type: "disabled"}`
//     turns it off; the cap is `max_tokens`.
//   Gemini (OpenAI-compatible endpoint): Gemini 3 models cannot turn thinking
//     off; gemini-3.5-flash-lite defaults to the `minimal` level, so nothing is
//     sent. The compatible endpoint does not document an output-cap field, so
//     none is sent either.
//
// Prices (US dollars per million tokens) and caching rules were read off each
// provider's pricing and prompt-caching pages on 2026-11-12:
//   Anthropic: claude-haiku-5-5 at prompts up to 100K tokens: input 0.10,
//     output 0.50, 5-minute cache write 0.125, cache read 0.01. Caches only at
//     explicit breakpoints; a prefix needs 512 tokens; entries live 5 minutes
//     from their last read.
//   OpenAI: gpt-6-luna: input 0.10, output 0.50, cached input 0.01, 30-minute
//     cache write 0.125. From GPT-5.6 on, the default (implicit) mode writes
//     the whole prompt to the cache on every request and only finds it again
//     at message ends, so the preset marks explicit breakpoints instead; a
//     prefix needs 1,024 tokens.
//   DeepSeek: deepseek-flash: input 0.15 on a cache miss and 0.003 on a hit,
//     output 0.60; double on weekdays 01:00-04:00 and 06:00-10:00 UTC (Chinese
//     public holidays excepted, which is not modelled here). Caches shared
//     prefixes by itself, at no charge for writing.
//   Gemini: gemini-3.5-flash-lite paid tier: input 0.30, output 2.50 (thinking
//     included), cached input 0.03. Caches by itself on the native API; the
//     OpenAI-compatible endpoint does not say whether it does.

import type { Pricing } from '../core/usage';
import type { Protocol } from './client';

export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'gemini' | 'openaiCompatible';

export interface ProviderPreset {
	id: ProviderId;
	label: string;
	protocol: Protocol;
	/** Empty for `openaiCompatible`, whose URL comes from settings. */
	baseUrl: string;
	defaultModel: string;
	/** Field that carries the output cap; undefined sends none. */
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
	/** Fields that switch thinking off for the default model. */
	extraBody: Record<string, unknown>;
	keyRequired: boolean;
	/** OpenAI-compatible only: mark cache breakpoints the way OpenAI's GPT-5.6 and later expect. */
	cacheBreakpoints?: boolean;
	/**
	 * How long a request that has given its ghost text stays open for the
	 * provider to report what it used. Zero for local servers, where a
	 * finished request should free the model at once.
	 */
	usageWaitMs: number;
	/** Published prices of the default model. */
	pricing?: Pricing;
}

/**
 * OpenAI-compatible endpoints report usage in the last event of the stream,
 * after text the ghost text no longer needs. The output cap is close to the
 * length that is shown, so the stream ends soon after: the wait is short and
 * costs few tokens. Anthropic reports the input side in the first event and
 * never waits.
 */
const USAGE_WAIT_MS = 2000;

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
	anthropic: {
		id: 'anthropic',
		label: 'Anthropic',
		protocol: 'anthropic',
		baseUrl: 'https://api.anthropic.com',
		defaultModel: 'claude-haiku-5-5',
		maxTokensField: 'max_tokens',
		extraBody: { thinking: { type: 'disabled' } },
		keyRequired: true,
		usageWaitMs: USAGE_WAIT_MS,
		pricing: { model: 'claude-haiku-5-5', rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
	},
	openai: {
		id: 'openai',
		label: 'OpenAI',
		protocol: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		defaultModel: 'gpt-6-luna',
		maxTokensField: 'max_completion_tokens',
		extraBody: { reasoning_effort: 'none' },
		keyRequired: true,
		cacheBreakpoints: true,
		usageWaitMs: USAGE_WAIT_MS,
		pricing: { model: 'gpt-6-luna', rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
	},
	deepseek: {
		id: 'deepseek',
		label: 'DeepSeek',
		protocol: 'openai',
		baseUrl: 'https://api.deepseek.com',
		defaultModel: 'deepseek-flash',
		maxTokensField: 'max_tokens',
		extraBody: { thinking: { type: 'disabled' } },
		keyRequired: true,
		usageWaitMs: USAGE_WAIT_MS,
		pricing: {
			model: 'deepseek-flash',
			rates: { input: 0.15, output: 0.6, cacheRead: 0.003 },
			peak: {
				rates: { input: 0.3, output: 1.2, cacheRead: 0.006 },
				utcHours: [[1, 4], [6, 10]],
			},
		},
	},
	gemini: {
		id: 'gemini',
		label: 'Gemini',
		protocol: 'openai',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		defaultModel: 'gemini-3.5-flash-lite',
		extraBody: {},
		keyRequired: true,
		usageWaitMs: USAGE_WAIT_MS,
		pricing: { model: 'gemini-3.5-flash-lite', rates: { input: 0.3, output: 2.5, cacheRead: 0.03 } },
	},
	openaiCompatible: {
		id: 'openaiCompatible',
		label: 'OpenAI-compatible',
		protocol: 'openai',
		baseUrl: '',
		defaultModel: '',
		maxTokensField: 'max_tokens',
		extraBody: {},
		keyRequired: false,
		usageWaitMs: 0,
	},
};

/**
 * Chinese prose takes 0.8 to 1.35 tokens a character with the tokenizers that
 * can be run locally (o200k, cl100k, Claude's older one), English about 0.25.
 * Two a character leaves room for a tokenizer that needs more and for what is
 * trimmed off the front. A model that still runs into the cap is cut at its
 * last sentence end, see `cutOff` in the suggestion.
 */
const OUTPUT_TOKENS_PER_CHAR = 2;

/** Output cap for ghost text of at most `maxChars` characters: enough for it, with little to pay for beyond it. */
export function maxOutputTokens(maxChars: number): number {
	return Math.ceil(maxChars * OUTPUT_TOKENS_PER_CHAR);
}

/** A request with no complete answer after this long is dropped. */
export const REQUEST_TIMEOUT_MS = 30_000;
