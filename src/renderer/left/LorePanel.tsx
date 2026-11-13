import { useEffect, useRef, useState } from 'react';
import type { LoreEntry } from '../../core/library';
import { groupLore, groupOf, parseAliases } from '../../core/loreGroups';
import { useWorkspace } from '../workspace';
import { zh } from '../strings';
import { errorMessage } from '../errors';
type Edit = { kind: 'create' | 'aliases' | 'type'; entry?: LoreEntry };
export function LorePanel() {
	const workspace = useWorkspace();
	const groups = groupLore(workspace.reference.entries);
	const [menu, setMenu] = useState<{ entry: LoreEntry; x: number; y: number }>();
	const [edit, setEdit] = useState<Edit>();
	const [error, setError] = useState('');
	const closeMenu = () => {
		setMenu(undefined);
		workspace.focusEditor();
	};
	const closeEdit = () => {
		setEdit(undefined);
		workspace.focusEditor();
	};
	const run = async (operation: () => Promise<void>) => {
		closeMenu();
		try {
			if (await workspace.saveAll()) {
				await operation();
				setError('');
			}
		} catch (error) {
			setError(errorMessage(error));
		}
	};
	return (
		<>
			<div className="panel-actions">
				<button onClick={() => setEdit({ kind: 'create' })}>{zh.newLore}</button>
			</div>
			{error ? (
				<p role="alert" className="panel-error">
					{error}
				</p>
			) : null}
			<div className="tree" role="tree" aria-label={zh.lore}>
				{groups.map((group) => (
					<details open key={group.type}>
						<summary>{group.type || zh.ungrouped}</summary>
						{group.entries.map((entry) => (
							<button
								key={entry.id}
								className="tree-row lore-row"
								onClick={() => {
									void workspace.open(entry.id);
								}}
								onContextMenu={(event) => {
									event.preventDefault();
									setMenu({ entry, x: event.clientX, y: event.clientY });
								}}
							>
								<span>{entry.name}</span>
								<small>{[entry.always ? zh.always : '', entry.aliases.join('、')].filter(Boolean).join(' · ')}</small>
							</button>
						))}
					</details>
				))}
			</div>
			{menu ? (
				<div
					className="menu-backdrop"
					onMouseDown={closeMenu}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
							closeMenu();
						}
					}}
				>
					<div className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
						<button
							autoFocus
							role="menuitem"
							onClick={() => {
								void run(() => window.novel.reference.set(menu.entry.id, 'always', !menu.entry.always));
							}}
						>
							{menu.entry.always ? zh.unsetAlways : zh.setAlways}
						</button>
						<button
							role="menuitem"
							onClick={() => {
								setEdit({ kind: 'aliases', entry: menu.entry });
								setMenu(undefined);
							}}
						>
							{zh.setAliases}
						</button>
						<button
							role="menuitem"
							onClick={() => {
								setEdit({ kind: 'type', entry: menu.entry });
								setMenu(undefined);
							}}
						>
							{zh.setType}
						</button>
						<button
							role="menuitem"
							onClick={() => {
								const path = menu.entry.id;
								closeMenu();
								void window.novel.book.reveal(path).catch((error) => setError(errorMessage(error)));
							}}
						>
							{zh.reveal}
						</button>
					</div>
				</div>
			) : null}
			{edit ? (
				<LoreInput
					edit={edit}
					types={groups.map((group) => group.type)}
					close={closeEdit}
					submit={async (name, type) => {
						type = type.trim();
						if (edit.kind !== 'aliases' && !type) {
							return false;
						}
						if (!(await workspace.saveAll())) {
							return false;
						}
						if (edit.kind === 'create') {
							await workspace.open(await window.novel.reference.create(name, type));
						} else {
							await window.novel.reference.set(edit.entry!.id, edit.kind, edit.kind === 'aliases' ? parseAliases(name) : type);
						}
						return true;
					}}
				/>
			) : null}
		</>
	);
}
function LoreInput({
	edit,
	types,
	close,
	submit,
}: {
	edit: Edit;
	types: string[];
	close(): void;
	submit(name: string, type: string): Promise<boolean>;
}) {
	const [name, setName] = useState(edit.kind === 'aliases' ? edit.entry!.aliases.join('、') : '');
	const [type, setType] = useState(edit.entry ? groupOf(edit.entry) : (types[0] ?? ''));
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		form.current?.querySelector('input')?.focus();
	}, []);
	const title = edit.kind === 'create' ? zh.newLore : edit.kind === 'aliases' ? zh.setAliases : zh.setType;
	return (
		<div className="popover-backdrop">
			<form
				ref={form}
				className="input-popover"
				role="dialog"
				aria-label={title}
				onKeyDown={(event) => {
					if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
						close();
					}
				}}
				onSubmit={(event) => {
					event.preventDefault();
					if (pending) {
						return;
					}
					setPending(true);
					void submit(name, type)
						.then((done) => {
							if (done) {
								close();
							}
						})
						.catch((error) => setError(errorMessage(error)))
						.finally(() => setPending(false));
				}}
			>
				<h3>{title}</h3>
				{edit.kind !== 'type' ? (
					<label>
						{edit.kind === 'aliases' ? zh.aliases : zh.loreName}
						<input value={name} onChange={(event) => setName(event.target.value)} />
					</label>
				) : null}
				{edit.kind !== 'aliases' ? (
					<label>
						{zh.loreType}
						<input list="lore-types" value={type} onChange={(event) => setType(event.target.value)} />
						<datalist id="lore-types">
							{types.map((type) => (
								<option key={type} value={type} />
							))}
						</datalist>
					</label>
				) : null}
				{error ? <p role="alert">{error}</p> : null}
				<div className="panel-actions">
					<button type="button" onClick={close}>
						{zh.cancel}
					</button>
					<button disabled={pending || (edit.kind !== 'aliases' && !type.trim())} type="submit">
						{zh.confirm}
					</button>
				</div>
			</form>
		</div>
	);
}
