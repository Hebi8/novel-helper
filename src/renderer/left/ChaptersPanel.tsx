import type { BookNode } from '../../core/library';
import { zh } from '../strings';
interface Props {
	tree: BookNode;
	selected?: string;
	open(path: string): void;
}
export function ChaptersPanel({ tree, selected, open }: Props) {
	const node = (item: BookNode, depth: number) => (
		<div key={item.path} role="treeitem" aria-selected={item.path === selected} aria-expanded={item.children.length ? true : undefined}>
			<button
				className={`tree-row ${item.path === selected ? 'selected' : ''}`}
				style={{ paddingLeft: 12 + depth * 14 }}
				onClick={() => {
					if (item.kind === 'chapter') {
						open(item.path);
					}
				}}
			>
				<span className="tree-symbol">{item.kind === 'chapter' ? '·' : '⌄'}</span>
				<span className="tree-name">{item.name}</span>
				<small>
					{zh.outline} {item.outline ? '✓' : '✗'}
					{item.kind === 'chapter' ? ` · ${zh.summary} ${item.summary ? '✓' : '✗'}` : ''}
				</small>
			</button>
			{item.children.length ? <div role="group">{item.children.map((child) => node(child, depth + 1))}</div> : null}
		</div>
	);
	return (
		<div className="tree" role="tree" aria-label={zh.chapters}>
			{node(tree, 0)}
		</div>
	);
}
