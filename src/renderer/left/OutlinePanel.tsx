import { useState } from 'react';
import { TreeMenu } from '../scaffold/TreeMenu';
import { errorMessage } from '../errors';
import { useWorkspace } from '../workspace';
import type { ConflictCopy } from '../../core/conflict';
import { comparePaths } from '../../core/naturalSort';
import { stem } from '../../core/text';
import { zh } from '../strings';
export function OutlinePanel() {
	const workspace = useWorkspace();
	const [menu, setMenu] = useState<{ path: string; x: number; y: number }>();
	const [error, setError] = useState('');
	const paths = [...workspace.reference.outlines].sort(comparePaths);
	const conflicts = new Map<string, ConflictCopy[]>();
	for (const conflict of workspace.book?.conflicts ?? []) {
		const list = conflicts.get(conflict.original) ?? [];
		list.push(conflict);
		conflicts.set(conflict.original, list);
	}
	const renderCopies = (original: string | undefined, depth: number) =>
		(original ? (conflicts.get(original) ?? []) : []).map((copy) => (
			<div key={copy.path} role="treeitem">
				<button
					type="button"
					className="tree-row conflict-copy-row"
					style={{ paddingLeft: 12 + depth * 14 }}
					onClick={() => workspace.openConflict(copy.path)}
					onContextMenu={(event) => {
						event.preventDefault();
						event.stopPropagation();
						setMenu({ path: copy.path, x: event.clientX, y: event.clientY });
					}}
				>
					<span className="tree-name">{stem(copy.path)}</span>
					<small className="conflict-badge">{zh.conflictCopy}</small>
				</button>
			</div>
		));
	const branch = (prefix: string, depth: number) => {
		const segments = [...new Set(paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('/')[0]))];
		const folders = segments.filter((name) => !paths.includes(prefix + name));
		const merged = new Set(
			folders.flatMap((folder) => segments.filter((name) => name.replace(/\.(md|txt)$/, '') === folder && name !== folder).slice(0, 1)),
		);
		return segments
			.filter((name) => !merged.has(name))
			.map((name) => {
				const path = prefix + name;
				const folder = folders.includes(name);
				const file = folder ? [...merged].find((file) => file.replace(/\.(md|txt)$/, '') === name) : name;
				const filePath = file ? prefix + file : undefined;
				const copies = renderCopies(filePath, depth + 1);
				const label = file ? (
					<button
						onClick={(event) => {
							event.preventDefault();
							void workspace.open(prefix + file);
						}}
					>
						{name.replace(/\.(md|txt)$/, '')}
					</button>
				) : (
					name
				);
				return (
					<div
						key={path}
						role="treeitem"
						onContextMenu={(event) => {
							event.preventDefault();
							event.stopPropagation();
							setMenu({ path: file ? prefix + file : path, x: event.clientX, y: event.clientY });
						}}
					>
						{folder ? (
							<details open>
								<summary style={{ paddingLeft: 12 + depth * 14 }}>{label}</summary>
								<div role="group">
									{copies}
									{branch(path + '/', depth + 1)}
								</div>
							</details>
						) : (
							<>
								<div className="tree-row" style={{ paddingLeft: 12 + depth * 14 }}>
									{label}
								</div>
								{copies.length ? <div role="group">{copies}</div> : null}
							</>
						)}
					</div>
				);
			});
	};
	return (
		<div className="tree" role="tree" aria-label={zh.outline}>
			{error ? <p role="alert">{error}</p> : null}
			{branch('', 0)}
			{menu ? (
				<TreeMenu
					{...menu}
					close={() => setMenu(undefined)}
					actions={[
						{
							label: zh.reveal,
							run: () => {
								void window.novel.book.reveal(menu.path).catch((error) => setError(errorMessage(error)));
							},
						},
					]}
				/>
			) : null}
		</div>
	);
}
