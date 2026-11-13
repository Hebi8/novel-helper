import { useEffect, useState } from 'react';
import type { NamesLanguage } from '../../core/story';
import type { ScaffoldItem } from '../../core/scaffold';
import type { OpenResult } from '../../shared/api';
import { Popover } from './Popover';
import { errorMessage } from '../errors';
import { zh } from '../strings';
export function Initialize({ root, close, opened }: { root: string; close(): void; opened(result: OpenResult): void }) {
	const [language, setLanguage] = useState<NamesLanguage>('zh');
	const [items, setItems] = useState<ScaffoldItem[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	useEffect(() => {
		let alive = true;
		setLoading(true);
		void window.novel.structure
			.plan(root, language)
			.then((items) => {
				if (!alive) {
					return;
				}
				setItems(items);
				setSelected(items.filter((item) => !item.firstVolume).map((item) => item.path));
				setLoading(false);
			})
			.catch((error) => {
				if (alive) {
					setError(errorMessage(error));
					setLoading(false);
				}
			});
		return () => {
			alive = false;
		};
	}, [root, language]);
	return (
		<Popover
			title={zh.initialize}
			close={close}
			pending={pending || loading}
			submit={() => {
				setPending(true);
				void window.novel.structure
					.initialize(root, language, selected)
					.then(opened)
					.catch((error) => setError(errorMessage(error)))
					.finally(() => setPending(false));
			}}
		>
			<p className="folder-path">{root}</p>
			<label>
				{zh.namesLanguage}
				<select value={language} disabled={pending} onChange={(event) => setLanguage(event.target.value as NamesLanguage)}>
					<option value="en">{zh.englishNames}</option>
					<option value="zh">{zh.chineseNames}</option>
				</select>
			</label>
			<div className="scaffold-items">
				{items.map((item) => (
					<label key={item.path}>
						<input
							type="checkbox"
							checked={selected.includes(item.path)}
							disabled={pending}
							onChange={(event) =>
								setSelected((value) => (event.target.checked ? [...value, item.path] : value.filter((path) => path !== item.path)))
							}
						/>
						<span>
							{item.path}
							<small>{item.about}</small>
						</span>
					</label>
				))}
			</div>
			{error ? <p role="alert">{error}</p> : null}
		</Popover>
	);
}
