import type { MenuCommand } from '../../shared/api';
import type { useDocuments } from '../editor/useDocuments';
interface CommandTarget {
	documents: ReturnType<typeof useDocuments>;
	toggleLeft(): void;
	toggleRight(): void;
	left(section: number): void;
	right(section: number): void;
}
export function commands(target: CommandTarget): Record<MenuCommand, () => void> {
	const docs = target.documents;
	const active = () => docs.sessionRef.current.active;
	const editor = () => (active() ? docs.handles.current.get(active()!) : undefined);
	return {
		closeTab: () => {
			if (active()) {
				void docs.close(active()!);
			}
		},
		previousTab: () => docs.moveTab(-1),
		nextTab: () => docs.moveTab(1),
		find: () => editor()?.find(),
		manual: () => {
			editor()?.ghost.send({ type: 'manual' });
		},
		'left:toggle': target.toggleLeft,
		'right:toggle': target.toggleRight,
		'left:0': () => target.left(0),
		'left:1': () => target.left(1),
		'left:2': () => target.left(2),
		'right:0': () => target.right(0),
		'right:1': () => target.right(1),
		'right:2': () => target.right(2),
		flush: () => {
			void docs.saveAll().then((saved) => {
				if (saved) {
					window.novel.window.flushed();
				}
			});
		},
	};
}
