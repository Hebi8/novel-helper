import { useState } from 'react';
import { groupLore } from '../../core/loreGroups';
import { useWorkspace } from '../workspace';
import { LoreCard } from '../reference/LoreCard';
import { zh } from '../strings';
export function LorePanel() {
	const workspace = useWorkspace();
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState<string>();
	const needle = query.trim().toLocaleLowerCase();
	const entries = workspace.reference.entries;
	const groups = groupLore(entries.filter((entry) => entry.keys.some((key) => key.toLocaleLowerCase().includes(needle))));
	const entry = entries.find((entry) => entry.id === selected);
	return (
		<div className="reference-panel">
			<input
				className="panel-search"
				aria-label={zh.searchLore}
				placeholder={zh.searchLore}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<div className="reference-list">
				{groups.map((group) => (
					<details open key={group.type}>
						<summary>{group.type || zh.ungrouped}</summary>
						{group.entries.map((entry) => (
							<button
								key={entry.id}
								className={`tree-row ${entry.id === selected ? 'selected' : ''}`}
								onClick={() => setSelected(entry.id)}
							>
								{entry.name}
							</button>
						))}
					</details>
				))}
			</div>
			{entry ? (
				<LoreCard
					entry={entry}
					full
					open={() => {
						void workspace.open(entry.id);
					}}
				/>
			) : null}
		</div>
	);
}
