import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuickItem } from '../../shared/api';
import { rankQuick } from './quick';
import { useWorkspace } from '../workspace';
import { zh } from '../strings';
import { errorMessage } from '../errors';
export function QuickOpen({ close }: { close(): void }) {
	const workspace = useWorkspace();
	const [items, setItems] = useState<QuickItem[]>([]);
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState(0);
	const [error, setError] = useState('');
	const input = useRef<HTMLInputElement>(null);
	const results = useMemo(() => rankQuick(items, query).slice(0, 50), [items, query]);
	useEffect(() => {
		let alive = true;
		const previous = document.activeElement as HTMLElement;
		input.current?.focus();
		void window.novel.reference
			.quick()
			.then((data) => {
				if (alive) {
					setItems(data);
				}
			})
			.catch((error) => {
				if (alive) {
					setError(errorMessage(error));
				}
			});
		return () => {
			alive = false;
			previous?.focus();
		};
	}, []);
	const open = (item: QuickItem) => {
		close();
		void workspace.open(item.path, { line: item.line });
	};
	return (
		<div
			className="popover-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					close();
				}
			}}
		>
			<div
				role="dialog"
				aria-label={zh.quickOpen}
				className="quick-open"
				onKeyDown={(event) => {
					if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
						event.stopPropagation();
						close();
					}
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						setSelected((value) => Math.min(value + 1, results.length - 1));
					}
					if (event.key === 'ArrowUp') {
						event.preventDefault();
						setSelected((value) => Math.max(value - 1, 0));
					}
					if (event.key === 'Enter' && !event.nativeEvent.isComposing && results[selected]) {
						event.preventDefault();
						open(results[selected]);
					}
				}}
			>
				<input
					ref={input}
					aria-label={zh.quickOpen}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setSelected(0);
					}}
				/>
				{error ? <p role="alert">{error}</p> : null}
				<div role="listbox">
					{results.map((item, i) => (
						<button
							key={item.id}
							role="option"
							aria-selected={selected === i}
							onMouseEnter={() => setSelected(i)}
							onClick={() => open(item)}
						>
							<span>{item.title}</span>
							<small>{item.path}</small>
						</button>
					))}
				</div>
				{!results.length ? <p>{zh.noResults}</p> : null}
			</div>
		</div>
	);
}
