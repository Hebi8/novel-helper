// The versions of a story folder that are kept around the assistant's turns:
// what a snapshot holds, what changed between two of them, what going back
// to one takes, and which of them can be thrown away. Nothing here touches
// the disk; storage/snapshotStore.ts does.

import { comparePaths } from './naturalSort';
import { leadsOut } from './story';

/** Where the snapshots of a story folder are kept, relative to it. */
export const SNAPSHOT_DIR = '.novel-helper/snapshots';
/** A file larger than this is not kept: no chapter is, and a snapshot is taken before every turn. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** How much of a file is looked at to tell text from binary. */
const BINARY_PROBE_BYTES = 8000;
/** Folders that are never looked into, wherever they are. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

/** Whether a folder, by its path relative to the story folder, is left out of snapshots: the snapshots themselves, `.git`, `node_modules`. */
export function skipsFolder(path: string): boolean {
	return path === SNAPSHOT_DIR || SKIPPED_FOLDERS.has(path.slice(path.lastIndexOf('/') + 1));
}

/** Text or not, the way git tells: a NUL byte near the start means binary. */
export function looksBinary(content: Uint8Array): boolean {
	return content.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** The files of a snapshot: path relative to the story folder → SHA-256 of the content. */
export type Manifest = Record<string, string>;

/** One file that differs between two snapshots. No `before`: it was added. No `after`: it was removed. */
export interface Change {
	path: string;
	before?: string;
	after?: string;
}

export function changeKind(change: Change): 'added' | 'removed' | 'modified' {
	return change.before === undefined ? 'added' : change.after === undefined ? 'removed' : 'modified';
}

/** The files that differ between two snapshots, in path order. */
export function diff(before: Manifest, after: Manifest): Change[] {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...paths]
		.filter((path) => before[path] !== after[path])
		.sort(comparePaths)
		.map((path) => ({ path, ...(path in before && { before: before[path] }), ...(path in after && { after: after[path] }) }));
}

/**
 * What is kept of one turn of the assistant, or of one going back: the
 * story folder as it was right before, and, once it is over, what it changed.
 */
export interface SnapshotRecord {
	id: number;
	/** ISO time of the snapshot. */
	time: string;
	kind: 'turn' | 'revert';
	/** Of a turn: how the writer's message starts. */
	title?: string;
	/** Of going back: the record whose `files` were restored. */
	target?: number;
	files: Manifest;
	/** Missing while the turn is running, or when the window was closed during it. */
	changes?: Change[];
}

/** The start of a message, as the title of its turn. */
export function titleOf(message: string, limit = 60): string {
	const line = message.trim().split('\n')[0].trim();
	const chars = [...line];
	return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : line;
}

/**
 * A record read back from disk, or undefined when the text is not one. The
 * paths are used to write and delete files, so a record with a path that is
 * absolute or has a `..` step is not accepted at all.
 */
export function parseRecord(text: string): SnapshotRecord | undefined {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	const record = data as SnapshotRecord;
	if (typeof record !== 'object' || record === null || typeof record.id !== 'number' || typeof record.files !== 'object' || record.files === null) {
		return undefined;
	}
	const paths = [...Object.keys(record.files), ...(record.changes ?? []).map((change) => change.path)];
	return paths.some((path) => leadsOut(path) || /^(\/|[A-Za-z]:)/.test(path)) ? undefined : record;
}

/** What going back to a snapshot takes. */
export interface RestorePlan {
	/** Files to write with the content of that hash: changed since, or removed since. */
	write: Array<{ path: string; hash: string }>;
	/** Files made since, to delete. */
	remove: string[];
}

/** What takes the story folder from `current` back to `target`. Files that are in neither are left alone. */
export function restorePlan(target: Manifest, current: Manifest): RestorePlan {
	const plan: RestorePlan = { write: [], remove: [] };
	for (const change of diff(current, target)) {
		if (change.after === undefined) {
			plan.remove.push(change.path);
		} else {
			plan.write.push({ path: change.path, hash: change.after });
		}
	}
	return plan;
}

/** The records to drop so that the newest `keep` are left. */
export function expired(ids: readonly number[], keep: number): number[] {
	const sorted = [...ids].sort((a, b) => a - b);
	return sorted.slice(0, Math.max(0, sorted.length - Math.max(1, keep)));
}

/** Every content hash these records still need. */
export function referenced(records: readonly SnapshotRecord[]): Set<string> {
	const hashes = new Set<string>();
	for (const record of records) {
		Object.values(record.files).forEach((hash) => hashes.add(hash));
		for (const change of record.changes ?? []) {
			[change.before, change.after].forEach((hash) => hash !== undefined && hashes.add(hash));
		}
	}
	return hashes;
}
