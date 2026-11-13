import { useEffect, useRef, useState } from 'react';
import type { SearchResult, SearchMatch } from '../../shared/finish';
import { useWorkspace } from '../workspace';
import { zh } from '../strings';
import { errorMessage } from '../errors';
export function Search({ close }: { close(): void }) {
	const workspace = useWorkspace();
	const [query, setQuery] = useState('');
	const [result, setResult] = useState<SearchResult>({ total: 0, groups: [] });
	const [selected, setSelected] = useState(0);
	const [error, setError] = useState('');
	const composing = useRef(false);
	const rows = result.groups.flatMap((group) => group.matches.map((match) => ({ path: group.path, match })));
	useEffect(() => {
		let alive = true;
		setResult({ total: 0, groups: [] });
		setSelected(0);
		const timer = setTimeout(() => {
			void workspace
				.saveAll()
				.then(async (saved) => {
					if (!saved) {
						throw new Error(zh.assistantSaveFailed);
					}
					if (!alive) {
						return;
					}
					const value = await window.novel.finish.search(query);
					if (alive) {
						setResult(value);
						setError('');
					}
				})
				.catch((error) => {
					if (alive) {
						setError(errorMessage(error));
					}
				});
		}, 120);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [query]);
	const open = (path: string, match: SearchMatch) => {
		void workspace.open(path, { offset: match.offset }).then(() => {
			close();
			workspace.focusEditor();
		});
	};
	let row = 0;
	return (
		<div className="popover-backdrop">
			<div
				className="quick-open book-search"
				role="dialog"
				aria-label={zh.searchBook}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
						return;
					}
					if (event.key === 'Escape') {
						event.stopPropagation();
						close();
						workspace.focusEditor();
					}
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						setSelected((value) => Math.min(rows.length - 1, value + 1));
					}
					if (event.key === 'ArrowUp') {
						event.preventDefault();
						setSelected((value) => Math.max(0, value - 1));
					}
					if (event.key === 'Enter' && rows[selected]) {
						event.preventDefault();
						open(rows[selected].path, rows[selected].match);
					}
				}}
			>
				<div className="search-query">
					<input autoFocus aria-label={zh.searchBook} value={query} onChange={(event) => setQuery(event.target.value)} />
					<output>{zh.searchCount(result.total)}</output>
				</div>
				{error ? <p role="alert">{error}</p> : null}
				<div className="quick-results" role="listbox">
					{result.groups.map((group) => (
						<div key={group.path} role="group" aria-label={group.path}>
							<h4>{group.path}</h4>
							{group.matches.map((match) => {
								const i = row++;
								return (
									<button
										key={match.offset}
										role="option"
										aria-selected={selected === i}
										onMouseEnter={() => setSelected(i)}
										onClick={() => open(group.path, match)}
									>
										<small>{match.line + 1}</small>
										<span>
											{match.text.slice(0, match.column)}
											<strong>{match.text.slice(match.column, match.column + match.length)}</strong>
											{match.text.slice(match.column + match.length)}
										</span>
									</button>
								);
							})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
