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
}

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
	},
	gemini: {
		id: 'gemini',
		label: 'Gemini',
		protocol: 'openai',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		defaultModel: 'gemini-3.5-flash-lite',
		extraBody: {},
		keyRequired: true,
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
	},
};

/** Output cap: one sentence is well under 100 tokens; this leaves room without paying for runaway text. */
export const MAX_OUTPUT_TOKENS = 300;
/** A request with no complete sentence after this long is dropped. */
export const REQUEST_TIMEOUT_MS = 30_000;
