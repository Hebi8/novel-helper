import { useEffect, useState } from 'react';
import type { StructureAction, StructureInput as Input } from '../../shared/finish';
import { Popover } from './Popover';
import { zh } from '../strings';
import { errorMessage } from '../errors';
export function StructureInput({
	action,
	path,
	close,
	submit,
}: {
	action: StructureAction;
	path?: string;
	close(): void;
	submit(input: Input): Promise<boolean>;
}) {
	const [name, setName] = useState('');
	const [chapter, setChapter] = useState('');
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let alive = true;
		void window.novel.finish
			.suggest(action, path)
			.then((value) => {
				if (alive) {
					setName(value.name);
					setChapter(value.chapter);
					setLoading(false);
				}
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
	}, [action, path]);
	const title = action === 'chapter' ? zh.newChapter : action === 'level' ? zh.newLevel : zh.rename;
	return (
		<Popover
			title={title}
			close={close}
			pending={pending || loading}
			submit={() => {
				setPending(true);
				void submit({ action, path, name, chapter })
					.then((done) => {
						if (done) {
							close();
						}
					})
					.catch((error) => setError(errorMessage(error)))
					.finally(() => setPending(false));
			}}
		>
			<label>
				{zh.structureName}
				<input value={name} disabled={pending} onChange={(event) => setName(event.target.value)} />
			</label>
			{action === 'level' ? (
				<label>
					{zh.firstChapter}
					<input value={chapter} disabled={pending} onChange={(event) => setChapter(event.target.value)} />
				</label>
			) : null}
			{error ? <p role="alert">{error}</p> : null}
		</Popover>
	);
}
