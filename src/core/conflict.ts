// Identifying iCloud Drive conflict copies (`name 2.md`, `name 3.md`…) next to
// their original files in the same folder.

import { comparePaths } from './naturalSort';

export interface ConflictCopy {
	/** Relative path of the conflict copy. */
	path: string;
	/** Relative path of the original file in the same folder. */
	original: string;
}

const CONFLICT_STEM = /^(.+) ([2-9]|[1-9]\d+)$/;

/**
 * Whether a book's canonical `realpath` lies below the canonical iCloud Drive
 * root (`~/Library/Mobile Documents/`).
 */
export function isUnderICloudRoot(realBookRoot: string, realICloudRoot: string | undefined): boolean {
	const root = realICloudRoot?.replace(/\/+$/, '');
	return Boolean(root && realBookRoot.startsWith(`${root}/`));
}

/**
 * When `enabled` is true and `path` has the filename shape `<stem> <n>=2+<ext>`
 * for one of `extensions`, returns the candidate original path `<stem><ext>` in
 * the same folder; otherwise undefined.
 */
export function conflictCandidate(
	path: string,
	enabled: boolean,
	extensions: readonly string[] = ['.md'],
): string | undefined {
	if (!enabled) {
		return undefined;
	}
	const slash = path.lastIndexOf('/');
	const dir = slash === -1 ? '' : path.slice(0, slash + 1);
	const base = slash === -1 ? path : path.slice(slash + 1);
	const ext = extensions.find((item) => base.endsWith(item));
	if (!ext) {
		return undefined;
	}
	const stem = base.slice(0, -ext.length);
	if (!stem || stem.startsWith('.')) {
		return undefined;
	}
	const match = CONFLICT_STEM.exec(stem);
	if (!match || match[1].startsWith('.')) {
		return undefined;
	}
	return `${dir}${match[1]}${ext}`;
}

/**
 * Returns the original path in `existing` that `path` is an iCloud conflict
 * copy of when `enabled`, or undefined otherwise.
 */
export function conflictOriginal(
	path: string,
	existing: ReadonlySet<string>,
	enabled: boolean,
	extensions: readonly string[] = ['.md'],
): string | undefined {
	const candidate = conflictCandidate(path, enabled, extensions);
	return candidate !== undefined && existing.has(candidate) ? candidate : undefined;
}

/**
 * Finds all conflict copies among `paths` in natural path order when `enabled`.
 * When a conflict copy itself has a conflict copy (`a.md`, `a 2.md`, `a 2 2.md`),
 * `original` resolves to the non-conflict base file (`a.md`).
 */
export function findConflictCopies(
	paths: Iterable<string>,
	enabled: boolean,
	extensions: readonly string[] = ['.md'],
): ConflictCopy[] {
	if (!enabled) {
		return [];
	}
	const all = new Set(paths);
	const direct = new Map<string, string>();
	for (const path of all) {
		const original = conflictOriginal(path, all, true, extensions);
		if (original !== undefined) {
			direct.set(path, original);
		}
	}
	return [...direct.keys()].sort(comparePaths).map((path) => {
		let original = direct.get(path)!;
		const seen = new Set([path]);
		while (direct.has(original) && !seen.has(original)) {
			seen.add(original);
			original = direct.get(original)!;
		}
		return { path, original };
	});
}
