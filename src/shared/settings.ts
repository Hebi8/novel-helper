import { defaults, type LineHeightLevel, type Settings, type SettingKey } from './defaults';
import { zh } from '../renderer/strings';

export const LINE_HEIGHT_VALUES: Record<LineHeightLevel, number> = {
	tight: 1.65,
	normal: 1.95,
	loose: 2.25,
};

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
		if (
			!text.trim() ||
			!Number.isFinite(number) ||
			number < 0 ||
			((key === 'editor.fontSize' || key === 'editor.headingFontSize' || key === 'editor.lineWidth') && number === 0)
		) {
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

export type SettingsCategoryId = 'editor' | 'appearance' | 'continuation' | 'assistant' | 'usage' | 'icloud' | 'about';

export const settingGroups: { name: string; category: SettingsCategoryId; keys: SettingKey[] }[] = [
	{
		name: zh.settingsGroups.text,
		category: 'editor',
		keys: [
			'editor.fontFamily',
			'editor.fontSize',
			'editor.lineHeight',
			'editor.paragraphSpacing',
			'editor.firstLineIndent',
			'editor.lineWidth',
		],
	},
	{
		name: zh.settingsGroups.heading,
		category: 'editor',
		keys: ['editor.headingFontSize', 'editor.headingCenter'],
	},
	{
		name: zh.settingsGroups.view,
		category: 'editor',
		keys: ['editor.focusParagraph', 'editor.centerLine'],
	},
	{
		name: zh.settingsGroups.input,
		category: 'editor',
		keys: ['editor.autoPair'],
	},
	{
		name: zh.settingsGroups.wordCount,
		category: 'editor',
		keys: ['editor.dailyWordGoal', 'editor.dayStartHour'],
	},
	{
		name: zh.settingsGroups.files,
		category: 'editor',
		keys: ['files.lore', 'files.chapters', 'files.outlines', 'files.summaries', 'files.bookNames'],
	},
	{
		name: zh.settingsGroups.theme,
		category: 'appearance',
		keys: ['appearance.theme'],
	},
	{
		name: zh.settingsGroups.trigger,
		category: 'continuation',
		keys: ['enabled', 'trigger', 'debounceMs', 'maxSuggestionChars'],
	},
	{
		name: zh.settingsGroups.model,
		category: 'continuation',
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
	{
		name: zh.settingsGroups.context,
		category: 'continuation',
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
	{
		name: zh.settingsGroups.agent,
		category: 'assistant',
		keys: ['assistant.agent', 'assistant.command', 'assistant.args'],
	},
	{
		name: zh.settingsGroups.snapshots,
		category: 'assistant',
		keys: ['assistant.snapshots.keep', 'snapshots.intervalMinutes', 'snapshots.keep'],
	},
	{
		name: zh.settingsGroups.usage,
		category: 'usage',
		keys: ['usage.dailyLimitUsd', 'usage.prices'],
	},
];
