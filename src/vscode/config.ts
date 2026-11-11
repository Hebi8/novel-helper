import * as vscode from 'vscode';
import type { ContextLimits } from '../core/context';
import type { ModelRequest } from '../llm/client';
import { MAX_OUTPUT_TOKENS, PROVIDERS, REQUEST_TIMEOUT_MS, type ProviderId } from '../llm/providers';

export const SECTION = 'novelHelper';

export interface FilePatterns {
	lore: string[];
	chapters: string[];
	outlines: string[];
	summaries: string[];
}

export function filePatterns(scope?: vscode.Uri): FilePatterns {
	const c = vscode.workspace.getConfiguration(`${SECTION}.files`, scope);
	return {
		lore: c.get<string[]>('lore', []),
		chapters: c.get<string[]>('chapters', []),
		outlines: c.get<string[]>('outlines', []),
		summaries: c.get<string[]>('summaries', []),
	};
}

export interface ContextSettings extends ContextLimits {
	previousChapters: number;
}

export function contextSettings(scope?: vscode.Uri): ContextSettings {
	const c = vscode.workspace.getConfiguration(`${SECTION}.context`, scope);
	const n = (key: string) => c.get<number>(key, 0);
	return {
		beforeChars: n('beforeChars'),
		afterChars: n('afterChars'),
		scanChars: n('scanChars'),
		alwaysChars: n('alwaysChars'),
		matchedChars: n('matchedChars'),
		entryChars: n('entryChars'),
		outlineChars: n('outlineChars'),
		previousChapters: n('previousChapters'),
		previousChapterChars: n('previousChapterChars'),
	};
}

export interface CompletionSettings {
	enabled: boolean;
	trigger: 'auto' | 'manual';
	debounceMs: number;
	maxSuggestionChars: number;
}

export function completionSettings(): CompletionSettings {
	const c = vscode.workspace.getConfiguration(SECTION);
	return {
		enabled: c.get<boolean>('enabled', true),
		trigger: c.get<'auto' | 'manual'>('trigger', 'auto'),
		debounceMs: c.get<number>('debounceMs', 750),
		maxSuggestionChars: c.get<number>('maxSuggestionChars', 60),
	};
}

export function currentProvider(): ProviderId {
	const id = vscode.workspace.getConfiguration(SECTION).get<string>('provider', 'anthropic');
	return id in PROVIDERS ? (id as ProviderId) : 'anthropic';
}

/** Everything about the model except the prompt and the key. */
export type ModelSettings = Omit<ModelRequest, 'system' | 'stable' | 'dynamic' | 'apiKey'> & {
	provider: ProviderId;
	keyRequired: boolean;
};

export function modelSettings(): ModelSettings {
	const c = vscode.workspace.getConfiguration(SECTION);
	const provider = currentProvider();
	const preset = PROVIDERS[provider];
	const custom = provider === 'openaiCompatible';
	return {
		provider,
		protocol: preset.protocol,
		baseUrl: custom ? c.get<string>('openaiCompatible.baseUrl', '') : preset.baseUrl,
		model: c.get<string>(`${provider}.model`, '') || preset.defaultModel,
		maxTokens: MAX_OUTPUT_TOKENS,
		maxTokensField: preset.maxTokensField,
		extraBody: { ...preset.extraBody, ...c.get<Record<string, unknown>>('extraRequestBody', {}) },
		timeoutMs: REQUEST_TIMEOUT_MS,
		keyRequired: preset.keyRequired,
	};
}

export function secretKey(provider: ProviderId): string {
	return `${SECTION}.apiKey.${provider}`;
}
