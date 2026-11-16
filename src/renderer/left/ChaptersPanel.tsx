import { useEffect, useRef, useState } from 'react';
import type { ConflictCopy } from '../../core/conflict';
import type { BookNode } from '../../core/library';
import { stem } from '../../core/text';
import { errorMessage } from '../errors';
import { TreeMenu, type TreeMenuAction } from '../scaffold/TreeMenu';
import { zh } from '../strings';
import { useWorkspace } from '../workspace';

interface Props {
	tree: BookNode;
	bookName: string;
	renameBookRequest: number;
	selected?: string;
	open(path: string): void;
}

export function ChaptersPanel({ tree, bookName, renameBookRequest, selected, open }: Props) {
	const workspace = useWorkspace();
	const [error, setError] = useState('');
	const [menu, setMenu] = useState<{ item: BookNode; x: number; y: number }>();
	const [conflictMenu, setConflictMenu] = useState<{ path: string; x: number; y: number }>();
	const [editingBook, setEditingBook] = useState(false);
	const [bookDraft, setBookDraft] = useState(bookName);
	const [savingBook, setSavingBook] = useState(false);
	const bookInputRef = useRef<HTMLInputElement>(null);
	const committingRef = useRef(false);

	const startBookRename = () => {
		setBookDraft(bookName);
		setEditingBook(true);
	};

	useEffect(() => {
		if (renameBookRequest > 0) {
			setBookDraft(bookName);
			setEditingBook(true);
		}
	}, [renameBookRequest]);

	useEffect(() => {
		if (editingBook) {
			bookInputRef.current?.focus();
			bookInputRef.current?.select();
		}
	}, [editingBook]);

	const commitBookTitle = async () => {
		const next = bookDraft.trim();
		if (!next || savingBook) {
			return;
		}
		if (next === bookName) {
			setEditingBook(false);
			workspace.focusEditor();
			return;
		}
		committingRef.current = true;
		setSavingBook(true);
		try {
			await window.novel.book.renameTitle(next);
			setError('');
			setEditingBook(false);
			workspace.focusEditor();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			committingRef.current = false;
			setSavingBook(false);
		}
	};

	const conflicts = new Map<string, ConflictCopy[]>();
	for (const conflict of workspace.book?.conflicts ?? []) {
		const list = conflicts.get(conflict.original) ?? [];
		list.push(conflict);
		conflicts.set(conflict.original, list);
	}

	const companion = async (item: BookNode, kind: 'outline' | 'summary') => {
		try {
			if (await workspace.saveAll()) {
				await workspace.open(await window.novel.reference.companion(item.path, kind));
			}
		} catch (err) {
			setError(errorMessage(err));
		}
	};

	const reveal = (path: string) => {
		void window.novel.book.reveal(path).catch((err) => setError(errorMessage(err)));
	};

	const actionsFor = (item: BookNode): TreeMenuAction[] => {
		if (item.kind === 'book') {
			return [
				{ label: zh.renameBook, run: () => startBookRename() },
				{ label: zh.newVolume, run: () => workspace.structure('level', '') },
				{ label: zh.newChapter, run: () => workspace.structure('chapter', '') },
				{ label: zh.reveal, run: () => reveal(item.path) },
			];
		}
		if (item.kind === 'level') {
			return [
				{ label: zh.rename, run: () => workspace.structure('rename', item.path) },
				{ label: zh.newChapter, run: () => workspace.structure('chapter', item.path) },
				{ label: zh.newSublevel, run: () => workspace.structure('level', item.path) },
				{ label: zh.reveal, run: () => reveal(item.path) },
				{
					label: zh.moveToTrash,
					separatorBefore: true,
					danger: true,
					run: () => workspace.trash({ kind: 'structure', path: item.path }),
				},
			];
		}
		return [
			{ label: zh.rename, run: () => workspace.structure('rename', item.path) },
			{ label: zh.reveal, run: () => reveal(item.path) },
			{
				label: zh.moveToTrash,
				separatorBefore: true,
				danger: true,
				run: () => workspace.trash({ kind: 'structure', path: item.path }),
			},
		];
	};

	const node = (item: BookNode, depth: number) => {
		const copies = item.path ? (conflicts.get(item.path) ?? []) : [];
		const isBook = item.kind === 'book';
		const isSelected = !isBook && item.path === selected;
		const isMenuOpen = menu?.item.path === item.path;
		return (
			<div
				key={item.path}
				role="treeitem"
				aria-selected={isSelected}
				aria-expanded={item.children.length || copies.length ? true : undefined}
			>
				<div
					className={`tree-row ${isBook ? 'book-row' : ''} ${isSelected ? 'selected' : ''} ${isMenuOpen ? 'menu-open' : ''}`}
					style={{ paddingLeft: 12 + depth * 14 }}
					onContextMenu={(event) => {
						event.preventDefault();
						setMenu({ item, x: event.clientX, y: event.clientY });
					}}
					onDoubleClick={
						isBook
							? (event) => {
									event.preventDefault();
									startBookRename();
								}
							: undefined
					}
					onClick={() => {
						if (item.kind === 'chapter') {
							open(item.path);
						}
					}}
				>
					<span className="tree-symbol">{item.kind === 'chapter' ? '·' : '⌄'}</span>
					{isBook && editingBook ? (
						<input
							ref={bookInputRef}
							type="text"
							className="book-title-input"
							aria-label={zh.renameBook}
							value={bookDraft}
							disabled={savingBook}
							onClick={(event) => event.stopPropagation()}
							onDoubleClick={(event) => event.stopPropagation()}
							onContextMenu={(event) => event.stopPropagation()}
							onChange={(event) => setBookDraft(event.target.value)}
							onBlur={() => {
								if (!committingRef.current) {
									setEditingBook(false);
								}
							}}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) {
									return;
								}
								if (event.key === 'Escape') {
									event.preventDefault();
									event.stopPropagation();
									setEditingBook(false);
									workspace.focusEditor();
								} else if (event.key === 'Enter') {
									event.preventDefault();
									event.stopPropagation();
									void commitBookTitle();
								}
							}}
						/>
					) : (
						<>
							<button type="button" className="tree-name">
								{isBook ? bookName : item.name}
							</button>
							<small onDoubleClick={(event) => event.stopPropagation()}>
								<button
									type="button"
									onClick={(event) => {
										event.stopPropagation();
										void companion(item, 'outline');
									}}
								>
									{zh.outline} {item.outline ? '✓' : '✗'}
								</button>
								{item.kind === 'chapter' ? (
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											void companion(item, 'summary');
										}}
									>
										{zh.summary} {item.summary ? '✓' : '✗'}
									</button>
								) : null}
							</small>
							<span className="row-actions" onDoubleClick={(event) => event.stopPropagation()}>
								{isBook ? (
									<>
										<button
											type="button"
											className="row-act"
											onClick={(event) => {
												event.stopPropagation();
												workspace.structure('level', '');
											}}
										>
											{zh.addVolume}
										</button>
										<button
											type="button"
											className="row-act"
											onClick={(event) => {
												event.stopPropagation();
												workspace.structure('chapter', '');
											}}
										>
											{zh.addChapter}
										</button>
									</>
								) : item.kind === 'level' ? (
									<button
										type="button"
										className="row-act"
										onClick={(event) => {
											event.stopPropagation();
											workspace.structure('chapter', item.path);
										}}
									>
										{zh.addChapter}
									</button>
								) : null}
								<button
									type="button"
									className="row-act row-dots"
									onClick={(event) => {
										event.stopPropagation();
										const rect = event.currentTarget.getBoundingClientRect();
										setMenu({ item, x: rect.left, y: rect.bottom + 4 });
									}}
								>
									{zh.moreActions}
								</button>
							</span>
						</>
					)}
				</div>
				{copies.length || item.children.length ? (
					<div role="group">
						{copies.map((copy) => (
							<div key={copy.path} role="treeitem">
								<button
									type="button"
									className="tree-row conflict-copy-row"
									style={{ paddingLeft: 12 + (depth + 1) * 14 }}
									onClick={() => workspace.openConflict(copy.path)}
									onContextMenu={(event) => {
										event.preventDefault();
										event.stopPropagation();
										setConflictMenu({ path: copy.path, x: event.clientX, y: event.clientY });
									}}
								>
									<span className="tree-name">{stem(copy.path)}</span>
									<small className="conflict-badge">{zh.conflictCopy}</small>
								</button>
							</div>
						))}
						{item.children.map((child) => node(child, depth + 1))}
					</div>
				) : null}
			</div>
		);
	};

	return (
		<div className="tree" role="tree" aria-label={zh.chapters}>
			{error ? <p role="alert">{error}</p> : null}
			{node(tree, 0)}
			{menu ? <TreeMenu x={menu.x} y={menu.y} close={() => setMenu(undefined)} actions={actionsFor(menu.item)} /> : null}
			{conflictMenu ? (
				<TreeMenu
					x={conflictMenu.x}
					y={conflictMenu.y}
					close={() => setConflictMenu(undefined)}
					actions={[
						{
							label: zh.reveal,
							run: () => reveal(conflictMenu.path),
						},
					]}
				/>
			) : null}
		</div>
	);
}
