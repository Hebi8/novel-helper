import { useWorkspace } from '../workspace';
import { comparePaths } from '../../core/naturalSort';
import { zh } from '../strings';
export function OutlinePanel() {
	const workspace = useWorkspace();
	const paths = [...workspace.reference.outlines].sort(comparePaths);
	const branch = (prefix: string, depth: number) => {
		const segments = [...new Set(paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('/')[0]))];
		return segments.map((name) => {
			const path = prefix + name;
			const file = paths.includes(path);
			return (
				<div key={path} role="treeitem">
					{file ? (
						<button
							className="tree-row"
							style={{ paddingLeft: 12 + depth * 14 }}
							onClick={() => {
								void workspace.open(path);
							}}
						>
							{name.replace(/\.(md|txt)$/, '')}
						</button>
					) : (
						<details open>
							<summary style={{ paddingLeft: 12 + depth * 14 }}>{name}</summary>
							<div role="group">{branch(path + '/', depth + 1)}</div>
						</details>
					)}
				</div>
			);
		});
	};
	return (
		<div className="tree" role="tree" aria-label={zh.outline}>
			{branch('', 0)}
		</div>
	);
}
