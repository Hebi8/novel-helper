import * as vscode from 'vscode';
import type { ContextLimits } from '../core/context';
import type { Pricing, Rates } from '../core/usage';
import type { ModelRequest } from '../llm/client';
import { maxOutputTokens, PROVIDERS, REQUEST_TIMEOUT_MS, type ProviderId } from '../llm/providers';

export const SECTION = 'novelHelper';

export interface FilePatterns {
	lore: string[];
	chapters: string[];
	outlines: string[];
	summaries: string[];
	/** File names of the whole book's outline and summary. */
	bookNames: string[];
}

export function filePatterns(scope?: vscode.Uri): FilePatterns {
	const c = vscode.workspace.getConfiguration(`${SECTION}.files`, scope);
	return {
		lore: c.get<string[]>('lore', []),
		chapters: c.get<string[]>('chapters', []),
		outlines: c.get<string[]>('outlines', []),
		summaries: c.get<string[]>('summaries', []),
		bookNames: c.get<string[]>('bookNames', []),
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
		alwaysChars: n('alwaysChars'),
		matchedChars: n('matchedChars'),
		entryChars: n('entryChars'),
		bookOutlineChars: n('bookOutlineChars'),
		levelOutlineChars: n('levelOutlineChars'),
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
		maxSuggestionChars: c.get<number>('maxSuggestionChars', 100),
	};
}

export function currentProvider(): ProviderId {
	const id = vscode.workspace.getConfiguration(SECTION).get<string>('provider', 'anthropic');
	return id in PROVIDERS ? (id as ProviderId) : 'anthropic';
}

/** Everything about the model except the prompt and the key. */
export type ModelSettings = Omit<ModelRequest, 'system' | 'user' | 'apiKey'> & {
	provider: ProviderId;
	keyRequired: boolean;
	/** Published prices of the provider's default model. */
	pricing?: Pricing;
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
		maxTokens: maxOutputTokens(completionSettings().maxSuggestionChars),
		maxTokensField: preset.maxTokensField,
		extraBody: { ...preset.extraBody, ...c.get<Record<string, unknown>>('extraRequestBody', {}) },
		cacheBreakpoints: preset.cacheBreakpoints,
		timeoutMs: REQUEST_TIMEOUT_MS,
		usageWaitMs: preset.usageWaitMs,
		keyRequired: preset.keyRequired,
		pricing: preset.pricing,
	};
}

export interface UsageSettings {
	/** The user's own prices by model id, in US dollars per million tokens. */
	prices: Record<string, Rates>;
	/** Dollars a day after which automatic requests stop; 0 for no limit. */
	dailyLimitUsd: number;
}

export function usageSettings(): UsageSettings {
	const c = vscode.workspace.getConfiguration(`${SECTION}.usage`);
	return {
		prices: c.get<Record<string, Rates>>('prices', {}),
		dailyLimitUsd: c.get<number>('dailyLimitUsd', 0),
	};
}

export function secretKey(provider: ProviderId): string {
	return `${SECTION}.apiKey.${provider}`;
}

/** Writes a setting where it is set already: in the workspace if it has a value there, else in the user settings. */
export async function updateSetting(key: string, value: unknown): Promise<void> {
	const config = vscode.workspace.getConfiguration(SECTION);
	const target =
		config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await config.update(key, value, target);
}

/** The story folder setting of a workspace folder, as written. */
export function storyFolderSetting(scope: vscode.Uri): string {
	return vscode.workspace.getConfiguration(`${SECTION}.files`, scope).get<string>('storyFolder', '');
}

/**
 * Points a workspace folder's story folder at `path` ('' for the folder
 * itself). Where the story is belongs to the workspace, so this is written
 * to its settings, never to the user's. The empty path is written out too:
 * removing the value would bring back whatever the user settings, or the
 * workspace above a folder, say.
 */
export async function setStoryFolder(folder: vscode.WorkspaceFolder, path: string): Promise<void> {
	const target =
		(vscode.workspace.workspaceFolders ?? []).length > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
	await vscode.workspace.getConfiguration(`${SECTION}.files`, folder.uri).update('storyFolder', path, target);
}
