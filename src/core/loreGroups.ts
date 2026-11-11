// How the sidebar lays out lore entries and starts new ones: entries grouped
// by type, a template per type, and the folder a new entry goes in.

import { setField } from './frontmatter';
import { type LoreEntry, parseLoreEntry } from './library';
import type { Translate } from './report';
import { dirSegments } from './text';

/** The group an entry is listed under: its `type`, else the first folder of its path. */
export function groupOf(entry: LoreEntry): string {
	return entry.type ?? dirSegments(entry.id)[0] ?? '';
}

export interface LoreGroup {
	type: string;
	entries: LoreEntry[];
}

/** Entries by group, groups and entries in the order given. */
export function groupLore(entries: readonly LoreEntry[]): LoreGroup[] {
	const groups = new Map<string, LoreEntry[]>();
	for (const entry of entries) {
		const type = groupOf(entry);
		groups.set(type, [...(groups.get(type) ?? []), entry]);
	}
	return Array.from(groups, ([type, list]) => ({ type, entries: list }));
}

/** What the writer typed in the aliases box, as a list: split at commas (，,、;；), trimmed, no repeats. */
export function parseAliases(input: string): string[] {
	return [...new Set(input.split(/[,，、;；]/).map((alias) => alias.trim()).filter(Boolean))];
}

function mostCommon(values: string[]): string | undefined {
	const counts = new Map<string, number>();
	values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The folder for a new entry of `type`: where most entries of that type are;
 * for a new type, the lore folder of that name if the settings have one
 * (人物), else the first lore folder of the settings that has entries, else
 * the first one. `folders` are the lore folders of the settings, see `globFolders`.
 */
export function folderForNew(type: string, entries: readonly LoreEntry[], folders: readonly string[]): string {
	const folderOf = (entry: LoreEntry) => dirSegments(entry.id).join('/');
	const inUse = (folder: string) => entries.some((entry) => folder === '' || entry.id.startsWith(`${folder}/`));
	return (
		mostCommon(entries.filter((entry) => groupOf(entry) === type).map(folderOf)) ??
		folders.find((folder) => folder === type) ??
		folders.find(inUse) ??
		folders[0] ??
		''
	);
}

const KINDS: Array<{ types: string[]; headings: (t: Translate) => string[] }> = [
	{
		types: ['人物', '角色', 'character', 'characters'],
		headings: (t) => [t('Appearance'), t('Personality'), t('Background')],
	},
	{
		types: ['地点', '地理', 'location', 'locations', 'place', 'places'],
		headings: (t) => [t('What it looks like'), t('Who is there'), t('What happened here')],
	},
	{
		types: ['物件', '物品', '道具', 'item', 'items'],
		headings: (t) => [t('What it looks like'), t('What it does'), t('Where it came from')],
	},
	{
		types: ['势力', '组织', 'faction', 'factions'],
		headings: (t) => [t('What it wants'), t('Who is in it'), t('How it stands with the others')],
	},
];

/**
 * The file a new entry starts as when the workspace has no template of its
 * own for the type: the frontmatter fields to fill in and two or three
 * headings.
 */
export function builtinTemplate(type: string, t: Translate): string {
	const kind = KINDS.find((k) => k.types.includes(type.toLowerCase()));
	const headings = kind ? kind.headings(t) : [t('Overview'), t('Details')];
	const body = headings.map((heading) => `## ${heading}\n`).join('\n');
	const template = `---\ntype:\naliases: []\nsummary:\n---\n\n${body}`;
	return type ? setField(template, 'type', type) : template;
}

/**
 * The content of a new entry at `path` from a template of the workspace:
 * `{{name}}` and `{{type}}` replaced, and `type` set in the frontmatter
 * unless the entry would be listed under that type anyway.
 */
export function fillTemplate(template: string, path: string, name: string, type: string): string {
	const content = template.replaceAll('{{name}}', name).replaceAll('{{type}}', type);
	return groupOf(parseLoreEntry(path, content)) === type ? content : setField(content, 'type', type);
}
