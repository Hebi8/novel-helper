import type { QuickItem } from '../../shared/api';
import { comparePaths } from '../../core/naturalSort';
export function rankQuick(items: readonly QuickItem[], query: string): QuickItem[] {
	const needle = query.trim().toLocaleLowerCase();
	const rank = (item: QuickItem) =>
		Math.min(
			...[item.title, ...item.aliases].map((key) => {
				const value = key.toLocaleLowerCase();
				return value === needle ? 0 : value.startsWith(needle) ? 1 : value.includes(needle) ? 2 : Infinity;
			}),
		);
	return items
		.map((item, order) => ({ item, order, score: needle ? rank(item) : 0 }))
		.filter(({ score }) => Number.isFinite(score))
		.sort(
			(a, b) => a.score - b.score || comparePaths(a.item.path, b.item.path) || (a.item.line ?? 0) - (b.item.line ?? 0) || a.order - b.order,
		)
		.map(({ item }) => item);
}
