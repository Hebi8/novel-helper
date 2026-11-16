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

/**
 * Whether a path that is meant to be inside the story folder has a `..`
 * step, which could lead out of it. Folder and file names come from
 * settings as well as from the writer, so every path the extension is about
 * to create or rename goes through this. By the text of the path: links
 * are not followed.
 */
export function leadsOut(path: string): boolean {
	return path.split(/[\\/]/).includes('..');
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
	title?: string;
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
	const { version, title, language, folders, book } = data as Record<string, unknown>;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		return undefined;
	}
	const marker: Marker = { version };
	if (typeof title === 'string' && title.trim()) {
		marker.title = title.trim();
	}
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
 * Sets or updates top-level `title` in a marker JSON text while leaving all
 * other fields and their formatting byte-for-byte unchanged.
 */
export function setMarkerTitle(raw: string, title: string): string | undefined {
	if (!parseMarker(raw)) {
		return undefined;
	}
	const skipWs = (index: number) => {
		while (index < raw.length && (raw[index] === ' ' || raw[index] === '\t' || raw[index] === '\r' || raw[index] === '\n')) {
			index++;
		}
		return index;
	};
	const scanString = (index: number) => {
		let cursor = index + 1;
		while (cursor < raw.length) {
			if (raw[cursor] === '\\') {
				cursor += 2;
			} else if (raw[cursor] === '"') {
				return cursor + 1;
			} else {
				cursor++;
			}
		}
		return cursor;
	};
	const scanValue = (index: number) => {
		if (raw[index] === '"') {
			return scanString(index);
		}
		if (raw[index] === '{' || raw[index] === '[') {
			let depth = 1;
			let cursor = index + 1;
			while (cursor < raw.length && depth > 0) {
				if (raw[cursor] === '"') {
					cursor = scanString(cursor);
				} else {
					if (raw[cursor] === '{' || raw[cursor] === '[') {
						depth++;
					} else if (raw[cursor] === '}' || raw[cursor] === ']') {
						depth--;
					}
					cursor++;
				}
			}
			return cursor;
		}
		let cursor = index;
		while (cursor < raw.length && !/[\s,}\]]/.test(raw[cursor])) {
			cursor++;
		}
		return cursor;
	};
	const open = skipWs(0);
	const props: { key: string; afterDelimiter: number; keyStart: number; keyEnd: number; valueStart: number; valueEnd: number }[] = [];
	let afterDelimiter = open + 1;
	let cursor = skipWs(afterDelimiter);
	while (cursor < raw.length && raw[cursor] !== '}') {
		const keyStart = cursor;
		const keyEnd = scanString(cursor);
		const key = JSON.parse(raw.slice(keyStart, keyEnd)) as string;
		const colon = skipWs(keyEnd);
		const valueStart = skipWs(colon + 1);
		const valueEnd = scanValue(valueStart);
		props.push({ key, afterDelimiter, keyStart, keyEnd, valueStart, valueEnd });
		cursor = skipWs(valueEnd);
		if (raw[cursor] === ',') {
			afterDelimiter = cursor + 1;
			cursor = skipWs(afterDelimiter);
		}
	}
	const encoded = JSON.stringify(title.trim());
	const existing = [...props].reverse().find((prop) => prop.key === 'title');
	if (existing) {
		return raw.slice(0, existing.valueStart) + encoded + raw.slice(existing.valueEnd);
	}
	const last = props[props.length - 1];
	const sep = raw.slice(last.afterDelimiter, last.keyStart);
	const colon = raw.slice(last.keyEnd, last.valueStart);
	return `${raw.slice(0, last.valueEnd)},${sep}"title"${colon}${encoded}${raw.slice(last.valueEnd)}`;
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
 * What to search for and what to leave out, so that the depth limit and the
 * big folders are part of the search itself: one glob per depth, and the
 * folders that are never looked into. Hidden folders cannot be excluded
 * here (the marker is in one); `storiesFromMarkers` drops those.
 */
export const MARKER_GLOBS: readonly string[] = Array.from({ length: SCAN_DEPTH + 1 }, (_, depth) => '*/'.repeat(depth) + MARKER_FILE);
export const SCAN_EXCLUDE = '**/{node_modules,.git,out,dist,build,target,vendor}/**';

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
