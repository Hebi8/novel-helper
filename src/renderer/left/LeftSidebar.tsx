import type { Book } from '../../shared/api';
import { ChaptersPanel } from './ChaptersPanel';
import { OutlinePanel } from './OutlinePanel';
import { LorePanel } from './LorePanel';
import { zh } from '../strings';
export function LeftSidebar({
	book,
	selected,
	section,
	select,
	open,
	hidden,
}: {
	book: Book;
	selected?: string;
	section: number;
	select(i: number): void;
	open(path: string): void;
	hidden: boolean;
}) {
	return (
		<aside className="sidebar left" style={{ display: hidden ? 'none' : undefined }}>
			<nav className="segments" aria-label={zh.left}>
				{[zh.chapters, zh.outline, zh.lore].map((label, i) => (
					<button key={label} aria-pressed={section === i} onClick={() => select(i)}>
						{label}
					</button>
				))}
			</nav>
			<div hidden={section !== 0}>
				<ChaptersPanel tree={book.tree} selected={selected} open={open} />
			</div>
			<div hidden={section !== 1}>
				<OutlinePanel />
			</div>
			<div hidden={section !== 2}>
				<LorePanel />
			</div>
		</aside>
	);
}
