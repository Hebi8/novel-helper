import { TreeMenu } from '../scaffold/TreeMenu';
import { useState } from 'react';
import { useWorkspace } from '../workspace';
import { errorMessage } from '../errors';
import type { BookNode } from '../../core/library';
import { zh } from '../strings';
interface Props {
	tree: BookNode;
	selected?: string;
	open(path: string): void;
}
export function ChaptersPanel({ tree, selected, open }: Props) {
	const workspace = useWorkspace();
	const [error, setError] = useState('');
	const [menu, setMenu] = useState<{ item: BookNode; x: number; y: number }>();
	const companion = async (item: BookNode, kind: 'outline' | 'summary') => {
		try {
			if (await workspace.saveAll()) {
				await workspace.open(await window.novel.reference.companion(item.path, kind));
			}
		} catch (error) {
			setError(errorMessage(error));
		}
	};
	const node = (item: BookNode, depth: number) => (
		<div key={item.path} role="treeitem" aria-selected={item.path === selected} aria-expanded={item.children.length ? true : undefined}>
			<div
				className={`tree-row ${item.path === selected ? 'selected' : ''}`}
				style={{ paddingLeft: 12 + depth * 14 }}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({ item, x: event.clientX, y: event.clientY });
				}}
				onClick={() => {
					if (item.kind === 'chapter') {
						open(item.path);
					}
				}}
			>
				<span className="tree-symbol">{item.kind === 'chapter' ? '·' : '⌄'}</span>
				<button className="tree-name">{item.name}</button>
				<small>
					<button
						onClick={(event) => {
							event.stopPropagation();
							void companion(item, 'outline');
						}}
					>
						{zh.outline} {item.outline ? '✓' : '✗'}
					</button>
					{item.kind === 'chapter' ? (
						<button
							onClick={(event) => {
								event.stopPropagation();
								void companion(item, 'summary');
							}}
						>
							{zh.summary} {item.summary ? '✓' : '✗'}
						</button>
					) : null}
				</small>
			</div>
			{item.children.length ? <div role="group">{item.children.map((child) => node(child, depth + 1))}</div> : null}
		</div>
	);
	return (
		<div className="tree" role="tree" aria-label={zh.chapters}>
			{error ? <p role="alert">{error}</p> : null}
			{node(tree, 0)}
			{menu ? (
				<TreeMenu
					x={menu.x}
					y={menu.y}
					close={() => setMenu(undefined)}
					actions={[
						{ label: zh.newChapter, run: () => workspace.structure('chapter', menu.item.path) },
						{ label: zh.newLevel, run: () => workspace.structure('level', menu.item.path) },
						...(menu.item.kind === 'book' ? [] : [{ label: zh.rename, run: () => workspace.structure('rename', menu.item.path) }]),
						{
							label: zh.reveal,
							run: () => {
								void window.novel.book.reveal(menu.item.path).catch((error) => setError(errorMessage(error)));
							},
						},
					]}
				/>
			) : null}
		</div>
	);
}
