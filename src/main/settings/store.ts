import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { defaults, type Settings, type SettingKey } from '../../shared/defaults';
import type { AssistantOption } from '../../shared/assistant';
import { PROVIDERS, REQUEST_TIMEOUT_MS, maxOutputTokens, type ProviderId } from '../../llm/providers';
import type { ContextLimits } from '../../core/context';
import type { Rates } from '../../core/usage';

export interface StoredAgentOptions {
	options: AssistantOption[];
	selected: Record<string, string>;
}
export class SettingsStore {
	private readonly file: string;
	private value: Settings;
	private agentOptions: Record<string, StoredAgentOptions>;
	constructor(directory: string) {
		mkdirSync(directory, { recursive: true });
		this.file = join(directory, 'settings.json');
		const raw = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>) : {};
		const { 'assistant.options': savedOptions, ...rest } = raw;
		this.agentOptions = (savedOptions as Record<string, StoredAgentOptions> | undefined) ?? {};
		this.value = { ...structuredClone(defaults), ...(rest as Partial<Settings>) };
	}
	private write(): void {
		const payload = Object.keys(this.agentOptions).length ? { ...this.value, 'assistant.options': this.agentOptions } : this.value;
		writeFileSync(this.file + '.tmp', JSON.stringify(payload, null, 2));
		renameSync(this.file + '.tmp', this.file);
	}
	get(): Settings {
		return structuredClone(this.value);
	}
	set<K extends SettingKey>(key: K, value: Settings[K]): void {
		this.value[key] = value;
		this.write();
	}
	assistantOptions(agent: string): StoredAgentOptions | undefined {
		const stored = this.agentOptions[agent];
		return stored ? structuredClone(stored) : undefined;
	}
	setAssistantOptions(agent: string, value: StoredAgentOptions): void {
		if (!value.options.length && !Object.keys(value.selected).length) {
			delete this.agentOptions[agent];
		} else {
			this.agentOptions[agent] = structuredClone(value);
		}
		this.write();
	}
	model() {
		const c = this.value;
		const provider = c.provider as ProviderId;
		const preset = PROVIDERS[provider];
		return {
			provider,
			protocol: preset.protocol,
			baseUrl: provider === 'openaiCompatible' ? c['openaiCompatible.baseUrl'] : preset.baseUrl,
			model: c[`${provider}.model`] || preset.defaultModel,
			maxTokens: maxOutputTokens(c.maxSuggestionChars),
			maxTokensField: preset.maxTokensField,
			extraBody: { ...preset.extraBody, ...c.extraRequestBody },
			cacheBreakpoints: preset.cacheBreakpoints,
			timeoutMs: REQUEST_TIMEOUT_MS,
			usageWaitMs: preset.usageWaitMs,
			keyRequired: preset.keyRequired,
			pricing: preset.pricing,
		};
	}
	limits(): ContextLimits & { previousChapters: number } {
		return Object.fromEntries(
			Object.entries(this.value)
				.filter(([key]) => key.startsWith('context.'))
				.map(([key, value]) => [key.slice(8), value]),
		) as unknown as ContextLimits & { previousChapters: number };
	}
	prices(): Record<string, Rates> {
		return this.value['usage.prices'];
	}
}
