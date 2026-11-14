import { defaults, type Settings, type SettingKey } from './defaults';
import { zh } from '../renderer/strings';
export const jsonSettings = Object.keys(defaults).filter((key) => typeof defaults[key as SettingKey] === 'object') as SettingKey[];
export function parseSetting<K extends SettingKey>(key: K, text: string): Settings[K] {
	const original = defaults[key];
	if (typeof original === 'object') {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error(zh.invalidJson);
		}
		if (
			Array.isArray(original)
				? !Array.isArray(value) || !value.every((item) => typeof item === 'string')
				: typeof value !== 'object' || value === null || Array.isArray(value)
		) {
			throw new Error(zh.invalidJsonType);
		}
		return value as Settings[K];
	}
	if (typeof original === 'number') {
		const number = Number(text);
		if (!text.trim() || !Number.isFinite(number) || number < 0 || (key === 'editor.fontSize' && number === 0)) {
			throw new Error(zh.invalidNumber);
		}
		return number as Settings[K];
	}
	return text as Settings[K];
}
export async function saveSettingText<K extends SettingKey>(
	key: K,
	text: string,
	save: (key: K, value: Settings[K]) => Promise<void>,
): Promise<void> {
	await save(key, parseSetting(key, text));
}
export const settingGroups: { name: string; keys: SettingKey[] }[] = [
	{ name: zh.settingsWriting, keys: ['editor.fontFamily', 'editor.fontSize', 'editor.centerLine'] },
	{ name: zh.continuation, keys: ['enabled', 'trigger', 'debounceMs', 'maxSuggestionChars'] },
	{
		name: zh.settingsModel,
		keys: [
			'provider',
			'anthropic.model',
			'openai.model',
			'deepseek.model',
			'gemini.model',
			'openaiCompatible.baseUrl',
			'openaiCompatible.model',
			'extraRequestBody',
		],
	},
	{ name: zh.settingsUsage, keys: ['usage.dailyLimitUsd', 'usage.prices'] },
	{ name: zh.assistant, keys: ['assistant.agent', 'assistant.command', 'assistant.args', 'assistant.snapshots.keep'] },
	{ name: zh.assistantSnapshots, keys: ['snapshots.intervalMinutes', 'snapshots.keep'] },
	{ name: zh.settingsFiles, keys: ['files.lore', 'files.chapters', 'files.outlines', 'files.summaries', 'files.bookNames'] },
	{
		name: zh.settingsContext,
		keys: [
			'context.beforeChars',
			'context.afterChars',
			'context.alwaysChars',
			'context.matchedChars',
			'context.entryChars',
			'context.bookOutlineChars',
			'context.levelOutlineChars',
			'context.outlineChars',
			'context.nextNodeChars',
			'position.updateChars',
			'context.previousChapters',
			'context.previousChapterChars',
		],
	},
];
