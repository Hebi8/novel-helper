// Which of the agent's requests go through without asking the writer.
// The writer allowed changes anywhere in the story, every turn being kept as
// a snapshot that can be gone back to; so reading, searching and changing
// files inside the story folder is let through, and everything else (running
// commands, the network, paths outside) is asked about.

import * as path from 'node:path';

/**
 * Where a file is, seen from the story folder:
 * - `inside`: in it, and in no folder whose name starts with a dot.
 * - `hidden`: in it, but below a dot folder (`.git`, `.vscode`, `.novel-helper`, an agent's own settings). Those hold
 *   what tools run or go by, and the snapshots themselves, so changing them is asked about.
 * - `unkept`: in it, but nothing a snapshot holds (a folder, a file that is not text or is very large): a change
 *   there could not be gone back from, so it is asked about too. `locate` does not tell; see acp/places.ts.
 * - `outside`: not in the story folder.
 */
export type Where = 'inside' | 'hidden' | 'unkept' | 'outside';

/** Both paths absolute, with links already resolved by the caller. */
export function locate(story: string, file: string): Exclude<Where, 'unkept'> {
	const relative = path.relative(story, file);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		return 'outside';
	}
	const folders = relative.split(path.sep).slice(0, -1);
	return folders.some((folder) => folder.startsWith('.')) ? 'hidden' : 'inside';
}

/** What a tool call is to be judged by; a subset of ACP's tool call. */
export interface ToolCallLike {
	kind?: string | null;
	locations?: Array<{ path: string }> | null;
	content?: Array<{ type: string; path?: string }> | null;
}

/** The files a tool call is about: its locations, and the files of the diffs it shows. */
export function pathsOf(toolCall: ToolCallLike): string[] {
	const paths = [
		...(toolCall.locations ?? []).map((location) => location.path),
		...(toolCall.content ?? []).flatMap((content) => (content.type === 'diff' && content.path ? [content.path] : [])),
	];
	return [...new Set(paths)];
}

/**
 * Whether a tool call of this kind on files in these places goes through
 * (`allow`) or the writer is asked (`ask`). A call that names no file is
 * asked about: there is nothing to tell where it reaches.
 */
export function decide(kind: string | null | undefined, places: readonly Where[]): 'allow' | 'ask' {
	if (places.length === 0) {
		return 'ask';
	}
	if (kind === 'read' || kind === 'search') {
		return places.every((place) => place !== 'outside') ? 'allow' : 'ask';
	}
	if (kind === 'edit' || kind === 'delete' || kind === 'move') {
		return places.every((place) => place === 'inside') ? 'allow' : 'ask';
	}
	return 'ask';
}

/** The option that lets a request through this once: the agent keeps asking, and each request is judged by its own files. */
export function allowOnce(options: ReadonlyArray<{ optionId: string; kind: string }>): string | undefined {
	return options.find((option) => option.kind === 'allow_once')?.optionId;
}
