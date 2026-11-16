import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { ConflictCopy } from '../../core/conflict';
import { type LoreEntry, parseLoreEntry } from '../../core/library';
import { groupLore, groupOf, parseAliases, planNewLore } from '../../core/loreGroups';
import { stem } from '../../core/text';
import { TreeMenu } from '../scaffold/TreeMenu';
import { useWorkspace } from '../workspace';
import { zh } from '../strings';
import { errorMessage } from '../errors';

type FieldEdit = { kind: 'aliases' | 'type'; entry: LoreEntry };

export function LorePanel() {
	const workspace = useWorkspace();
	const groups = groupLore(workspace.reference.entries);
	const types = groups.map((group) => group.type).filter(Boolean);
	const [menu, setMenu] = useState<{ entry: LoreEntry; x: number; y: number }>();
	const [creating, setCreating] = useState<string>();
	const [edit, setEdit] = useState<FieldEdit>();
	const [error, setError] = useState('');
	const [conflictMenu, setConflictMenu] = useState<{ path: string; x: number; y: number }>();
	const conflicts = new Map<string, ConflictCopy[]>();
	for (const conflict of workspace.book?.conflicts ?? []) {
		const list = conflicts.get(conflict.original) ?? [];
		list.push(conflict);
		conflicts.set(conflict.original, list);
	}
	const closeMenu = () => {
		setMenu(undefined);
		workspace.focusEditor();
	};
	const closeCreate = () => {
		setCreating(undefined);
		workspace.focusEditor();
	};
	const closeEdit = () => {
		setEdit(undefined);
		workspace.focusEditor();
	};
	const defaultCreateType = () => {
		const activePath = workspace.session.active;
		const activeEntry = activePath ? workspace.reference.entries.find((entry) => entry.id === activePath) : undefined;
		if (activeEntry) {
			const current = workspace.current();
			const liveType =
				current && current.path === activeEntry.id ? groupOf(parseLoreEntry(current.path, current.text)) : groupOf(activeEntry);
			if (liveType) {
				return liveType;
			}
		}
		return types[0] ?? '';
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
			{error ? (
				<p role="alert" className="panel-error">
					{error}
				</p>
			) : null}
			<div className="tree" role="tree" aria-label={zh.lore}>
				{groups.map((group) => (
					<details open key={group.type}>
						<summary className="lore-group-summary">
							<span>{group.type || zh.ungrouped}</span>
							<button
								type="button"
								className="lore-group-add"
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
									setCreating(group.type);
								}}
							>
								＋
							</button>
						</summary>
						{group.entries.map((entry) => (
							<Fragment key={entry.id}>
								<button
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
								{(conflicts.get(entry.id) ?? []).map((copy) => (
									<button
										type="button"
										key={copy.path}
										className="tree-row lore-row conflict-copy-row"
										style={{ paddingLeft: 22 }}
										onClick={() => workspace.openConflict(copy.path)}
										onContextMenu={(event) => {
											event.preventDefault();
											setConflictMenu({ path: copy.path, x: event.clientX, y: event.clientY });
										}}
									>
										<span className="tree-name">{stem(copy.path)}</span>
										<small className="conflict-badge">{zh.conflictCopy}</small>
									</button>
								))}
							</Fragment>
						))}
					</details>
				))}
				<button type="button" className="tree-row lore-new-row" onClick={() => setCreating(defaultCreateType())}>
					{zh.newLoreRow}
				</button>
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
			{conflictMenu ? (
				<TreeMenu
					x={conflictMenu.x}
					y={conflictMenu.y}
					close={() => setConflictMenu(undefined)}
					actions={[
						{
							label: zh.reveal,
							run: () => {
								void window.novel.book.reveal(conflictMenu.path).catch((error) => setError(errorMessage(error)));
							},
						},
					]}
				/>
			) : null}
			{creating !== undefined ? (
				<NewLoreDialog
					initialType={creating}
					types={types}
					entries={workspace.reference.entries}
					loreGlobs={workspace.settings['files.lore']}
					close={closeCreate}
					submit={async (name, type) => {
						if (!(await workspace.saveAll())) {
							return false;
						}
						await workspace.open(await window.novel.reference.create(name, type));
						setError('');
						return true;
					}}
					fail={(message) => setError(message)}
				/>
			) : null}
			{edit ? (
				<LoreFieldDialog
					edit={edit}
					types={types}
					close={closeEdit}
					submit={async (value) => {
						if (edit.kind === 'type' && !value.trim()) {
							return false;
						}
						if (!(await workspace.saveAll())) {
							return false;
						}
						await window.novel.reference.set(edit.entry.id, edit.kind, edit.kind === 'aliases' ? parseAliases(value) : value.trim());
						return true;
					}}
				/>
			) : null}
		</>
	);
}

function NewLoreDialog({
	initialType,
	types,
	entries,
	loreGlobs,
	close,
	submit,
	fail,
}: {
	initialType: string;
	types: readonly string[];
	entries: readonly LoreEntry[];
	loreGlobs: readonly string[];
	close(): void;
	submit(name: string, type: string): Promise<boolean>;
	fail(message: string): void;
}) {
	const [name, setName] = useState('');
	const [chipTypes, setChipTypes] = useState<string[]>(() =>
		initialType && !types.includes(initialType) ? [...types, initialType] : [...types],
	);
	const [selectedType, setSelectedType] = useState(initialType);
	const [addingType, setAddingType] = useState(false);
	const [typeDraft, setTypeDraft] = useState('');
	const [pending, setPending] = useState(false);
	const nameId = useId();
	const nameRef = useRef<HTMLInputElement>(null);
	const typeInputRef = useRef<HTMLInputElement>(null);
	const addChipRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	useEffect(() => {
		if (addingType) {
			typeInputRef.current?.focus();
		}
	}, [addingType]);

	const effectiveType = addingType ? typeDraft.trim() : selectedType;
	const plan = planNewLore(name, effectiveType, entries, loreGlobs);

	const submitForm = () => {
		if (pending || !plan.valid) {
			return;
		}
		setPending(true);
		void submit(name, effectiveType)
			.then((done) => {
				if (done) {
					close();
				}
			})
			.catch((error) => {
				close();
				fail(errorMessage(error));
			})
			.finally(() => setPending(false));
	};

	return (
		<div className="popover-backdrop">
			<div
				className="lore-dialog"
				role="dialog"
				aria-label={zh.newLore}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === 'Escape' && !pending) {
						event.preventDefault();
						event.stopPropagation();
						close();
						return;
					}
					if (event.key === 'Enter' && event.target === nameRef.current) {
						event.preventDefault();
						submitForm();
					}
				}}
			>
				<h3>{zh.newLore}</h3>
				<div className="lore-dialog-field">
					<label htmlFor={nameId} className="lore-dialog-label">
						{zh.loreName}
					</label>
					<input
						ref={nameRef}
						id={nameId}
						type="text"
						className="lore-dialog-name"
						value={name}
						disabled={pending}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<div className="lore-dialog-field">
					<span className="lore-dialog-label">{zh.loreType}</span>
					<div className="lore-type-chips" role="group" aria-label={zh.loreType}>
						{chipTypes.map((item) => {
							const active = !addingType && selectedType === item;
							return (
								<button
									key={item}
									type="button"
									className={active ? 'lore-chip on' : 'lore-chip'}
									aria-pressed={active}
									disabled={pending}
									onClick={() => {
										setSelectedType(item);
										setAddingType(false);
										setTypeDraft('');
									}}
								>
									{item}
								</button>
							);
						})}
						{addingType ? (
							<input
								ref={typeInputRef}
								type="text"
								className="lore-chip-input"
								aria-label={zh.newTypePlaceholder}
								value={typeDraft}
								disabled={pending}
								onChange={(event) => setTypeDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) {
										return;
									}
									if (event.key === 'Escape') {
										event.preventDefault();
										event.stopPropagation();
										setAddingType(false);
										setTypeDraft('');
										requestAnimationFrame(() => addChipRef.current?.focus());
										return;
									}
									if (event.key === 'Enter') {
										event.preventDefault();
										event.stopPropagation();
										const next = typeDraft.trim();
										if (next) {
											setChipTypes((prev) => (prev.includes(next) ? prev : [...prev, next]));
											setSelectedType(next);
										}
										setAddingType(false);
										setTypeDraft('');
										requestAnimationFrame(() => nameRef.current?.focus());
									}
								}}
							/>
						) : (
							<button
								ref={addChipRef}
								type="button"
								className="lore-chip add"
								disabled={pending}
								onClick={() => {
									setAddingType(true);
									setTypeDraft('');
								}}
							>
								{zh.newTypeChip}
							</button>
						)}
					</div>
					<div className="lore-dialog-where">{zh.loreWhere(plan.preview)}</div>
				</div>
				<div className="lore-dialog-actions">
					<button type="button" className="lore-dialog-btn" disabled={pending} onClick={close}>
						{zh.cancel}
					</button>
					<button type="button" className="lore-dialog-btn primary" disabled={pending || !plan.valid} onClick={submitForm}>
						{zh.createLore}
					</button>
				</div>
			</div>
		</div>
	);
}

function LoreFieldDialog({
	edit,
	types,
	close,
	submit,
}: {
	edit: FieldEdit;
	types: string[];
	close(): void;
	submit(value: string): Promise<boolean>;
}) {
	const [value, setValue] = useState(edit.kind === 'aliases' ? edit.entry.aliases.join('、') : groupOf(edit.entry));
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		form.current?.querySelector('input')?.focus();
	}, []);
	const title = edit.kind === 'aliases' ? zh.setAliases : zh.setType;
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
					void submit(value)
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
				{edit.kind === 'aliases' ? (
					<label>
						{zh.aliases}
						<input value={value} onChange={(event) => setValue(event.target.value)} />
					</label>
				) : (
					<label>
						{zh.loreType}
						<input list="lore-types" value={value} onChange={(event) => setValue(event.target.value)} />
						<datalist id="lore-types">
							{types.map((type) => (
								<option key={type} value={type} />
							))}
						</datalist>
					</label>
				)}
				{error ? <p role="alert">{error}</p> : null}
				<div className="panel-actions">
					<button type="button" onClick={close}>
						{zh.cancel}
					</button>
					<button disabled={pending || (edit.kind === 'type' && !value.trim())} type="submit">
						{zh.confirm}
					</button>
				</div>
			</form>
		</div>
	);
}
