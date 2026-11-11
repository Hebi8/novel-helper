// Where the story is inside a workspace folder, and whether that place has
// been set up: the story folder setting, the marker file "Initialize" leaves
// there, and the story folders found by their markers.

import { comparePaths } from './naturalSort';

/** The marker of an initialized story folder, relative to it. */
export const MARKER_FILE = '.novel-helper/project.json';
export const MARKER_VERSION = 1;

/** Which names the folders and starter files were given: 正文, 大纲… or chapters, outlines… */
export type NamesLanguage = 'zh' | 'en';

export function namesLanguageOf(name: string): NamesLanguage {
	return /^[\x00-\x7f]*$/.test(name) ? 'en' : 'zh';
}

/**
 * The story folder setting as a `/`-separated path below the workspace
 * folder, '' for the folder itself. Undefined for a value that could lead
 * out of the workspace folder: an absolute path, `~`, or one with `..`.
 */
export function normalizeStoryFolder(setting: string): string | undefined {
	const path = setting.trim().replace(/\\/g, '/');
	if (/^(\/|~|[A-Za-z]:)/.test(path)) {
		return undefined;
	}
	const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
	return segments.includes('..') ? undefined : segments.join('/');
}

/** `path` relative to `folder` (both absolute, `/`-separated): '' for the folder itself, undefined outside it. */
export function relativeInside(folder: string, path: string): string | undefined {
	const base = folder.replace(/\/+$/, '');
	const target = path.replace(/\/+$/, '');
	if (target === base) {
		return '';
	}
	return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : undefined;
}

/**
 * What the marker file holds: the format version and the names the story
 * was set up with. Nothing about the machine or the provider.
 */
export interface Marker {
	version: number;
	language?: NamesLanguage;
	/** The folders made for each kind of file, relative to the story folder. */
	folders?: { chapters?: string; outlines?: string; summaries?: string; lore?: string[] };
	/** File name (extension aside) of the whole book's outline. */
	book?: string;
}

export function serializeMarker(marker: Marker): string {
	return `${JSON.stringify(marker, null, 2)}\n`;
}

/**
 * The marker a file's text holds, or undefined when it is not one: not
 * JSON, or without a version number. Fields this version does not know, or
 * of the wrong type, are dropped; a later version's marker still counts.
 */
export function parseMarker(text: string): Marker | undefined {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return undefined;
	}
	const { version, language, folders, book } = data as Record<string, unknown>;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		return undefined;
	}
	const marker: Marker = { version };
	if (language === 'zh' || language === 'en') {
		marker.language = language;
	}
	if (typeof folders === 'object' && folders !== null && !Array.isArray(folders)) {
		const { chapters, outlines, summaries, lore } = folders as Record<string, unknown>;
		const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
		marker.folders = {
			chapters: text(chapters),
			outlines: text(outlines),
			summaries: text(summaries),
			lore: Array.isArray(lore) ? lore.filter((name): name is string => typeof name === 'string') : undefined,
		};
	}
	if (typeof book === 'string') {
		marker.book = book;
	}
	return marker;
}

/**
 * - `invalid`: the setting is not a path inside the workspace folder.
 * - `missing`: there is no such folder.
 * - `empty`: the folder has no marker and nothing of a novel in it.
 * - `unmarked`: no marker, but chapters, outlines or lore are there (set up
 *   by an earlier version, or by hand). It works like `ready`.
 * - `ready`: the marker is there.
 */
export type StoryState = 'invalid' | 'missing' | 'empty' | 'unmarked' | 'ready';

export function storyState(facts: { valid: boolean; exists: boolean; marked: boolean; hasFiles: boolean }): StoryState {
	if (!facts.valid) {
		return 'invalid';
	}
	if (!facts.exists) {
		return 'missing';
	}
	if (facts.marked) {
		return 'ready';
	}
	return facts.hasFiles ? 'unmarked' : 'empty';
}

/** Whether the story folder can be written in as it is. */
export function isUsable(state: StoryState): boolean {
	return state === 'ready' || state === 'unmarked';
}

/** How many folders below the workspace folder a story folder is looked for. */
export const SCAN_DEPTH = 4;
/** Folders that are not looked into: dependencies, build output, anything hidden. */
const SKIPPED = /^(node_modules|out|dist|build|target|vendor)$|^\./;

/**
 * The story folders that marker files point to. `markers` are paths of
 * marker files relative to the workspace folder. Left out: the current
 * story folder, folders deeper than `SCAN_DEPTH`, and folders inside
 * dependencies, build output or hidden folders.
 */
export function storiesFromMarkers(markers: readonly string[], current?: string): string[] {
	const stories = new Set<string>();
	for (const marker of markers) {
		if (marker !== MARKER_FILE && !marker.endsWith(`/${MARKER_FILE}`)) {
			continue;
		}
		const story = marker.slice(0, Math.max(0, marker.length - MARKER_FILE.length - 1));
		const segments = story ? story.split('/') : [];
		if (story !== current && segments.length <= SCAN_DEPTH && !segments.some((segment) => SKIPPED.test(segment))) {
			stories.add(story);
		}
	}
	return [...stories].sort(comparePaths);
}
