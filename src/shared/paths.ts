import type { Rename } from '../core/library';
export function movedPath(path: string, renames: Rename[]): string {
	const move = renames.find((move) => path === move.from || path.startsWith(move.from + '/'));
	return move ? move.to + path.slice(move.from.length) : path;
}
