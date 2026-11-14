import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject } from 'react';
import type { LoreFormData } from '../../core/loreForm';
import { zh } from '../strings';

export interface LoreFormHandle {
	flush(): void;
}

interface Props {
	data: LoreFormData;
	types: readonly string[];
	commit(key: string, value: string | boolean): void;
	undo(): void;
	redo(): void;
	showSource(): void;
	handleRef: MutableRefObject<LoreFormHandle | undefined>;
}

function handleHistoryKey(event: KeyboardEvent<HTMLElement>, hasDraft: boolean, undo: () => void, redo: () => void): boolean {
	if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z' && !event.nativeEvent.isComposing) {
		event.stopPropagation();
		if (!hasDraft) {
			event.preventDefault();
			if (event.shiftKey) {
				redo();
			} else {
				undo();
			}
		}
		return true;
	}
	return false;
}

function handleHistoryBeforeInput(event: FormEvent<HTMLElement>, hasDraft: boolean, undo: () => void, redo: () => void): void {
	if (hasDraft) {
		return;
	}
	const inputType = (event.nativeEvent as InputEvent).inputType;
	if (inputType === 'historyUndo' || inputType === 'historyRedo') {
		event.preventDefault();
		if (inputType === 'historyRedo') {
			redo();
		} else {
			undo();
		}
	}
}

function TypeField({
	value,
	types,
	commit,
	undo,
	redo,
	setPending,
}: {
	value: string;
	types: readonly string[];
	commit(value: string): void;
	undo(): void;
	redo(): void;
	setPending(fn: (() => void) | undefined): void;
}) {
	const [editing, setEditing] = useState<string>();
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const composing = useRef(false);
	const boxRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const id = useId();
	useEffect(() => {
		setEditing(undefined);
	}, [value]);
	useEffect(() => {
		if (!open) {
			return;
		}
		const onMouseDown = (event: MouseEvent) => {
			if (!boxRef.current?.contains(event.target as Node)) {
				setOpen(false);
				setActiveIndex(-1);
			}
		};
		window.addEventListener('mousedown', onMouseDown);
		return () => window.removeEventListener('mousedown', onMouseDown);
	}, [open]);
	const finish = (next: string) => {
		setPending(undefined);
		setEditing(undefined);
		setOpen(false);
		setActiveIndex(-1);
		commit(next);
	};
	const current = editing ?? value;
	return (
		<div className="lore-field lore-field-type">
			<label htmlFor={id}>{zh.loreType}</label>
			<div className="lore-type-box" ref={boxRef}>
				<input
					ref={inputRef}
					id={id}
					type="text"
					value={current}
					onMouseDown={() => {
						if (types.length > 0) {
							setOpen(true);
						}
					}}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={() => {
						composing.current = false;
					}}
					onBeforeInput={(event) => handleHistoryBeforeInput(event, editing !== undefined, undo, redo)}
					onChange={(event) => {
						const next = event.target.value;
						setEditing(next);
						setActiveIndex(-1);
						setPending(() => {
							if (!composing.current) {
								setPending(undefined);
								setEditing(undefined);
								commit(next);
							}
						});
					}}
					onBlur={() => {
						if (composing.current) {
							return;
						}
						setOpen(false);
						setActiveIndex(-1);
						if (editing !== undefined) {
							finish(editing);
						}
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing || composing.current) {
							return;
						}
						if (handleHistoryKey(event, editing !== undefined, undo, redo)) {
							return;
						}
						if (event.key === 'ArrowDown' && types.length > 0) {
							event.preventDefault();
							if (!open) {
								setOpen(true);
								setActiveIndex(0);
							} else {
								setActiveIndex((index) => (index + 1) % types.length);
							}
							return;
						}
						if (event.key === 'ArrowUp' && open && types.length > 0) {
							event.preventDefault();
							setActiveIndex((index) => (index <= 0 ? types.length - 1 : index - 1));
							return;
						}
						if (event.key === 'Escape' && open) {
							event.preventDefault();
							event.stopPropagation();
							setOpen(false);
							setActiveIndex(-1);
							return;
						}
						if (event.key === 'Enter') {
							event.preventDefault();
							if (open && activeIndex >= 0 && activeIndex < types.length) {
								finish(types[activeIndex]);
							} else {
								finish(current);
							}
						}
					}}
				/>
				{types.length > 0 ? (
					<button
						type="button"
						className="lore-type-arrow"
						tabIndex={-1}
						aria-hidden="true"
						onMouseDown={(event) => {
							event.preventDefault();
							setOpen((wasOpen) => !wasOpen);
							setActiveIndex(-1);
							inputRef.current?.focus();
						}}
					>
						▾
					</button>
				) : null}
				{open && types.length > 0 ? (
					<div className="lore-type-menu" role="listbox">
						{types.map((option, index) => (
							<button
								key={option}
								type="button"
								role="option"
								aria-selected={index === activeIndex || (activeIndex === -1 && option === current)}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => finish(option)}
							>
								<span>{option}</span>
								{option === value ? <span aria-hidden="true">✓</span> : null}
							</button>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

function TextField({
	label,
	value,
	multiline = false,
	className,
	commit,
	undo,
	redo,
	setPending,
}: {
	label: string;
	value: string;
	multiline?: boolean;
	className?: string;
	commit(value: string): void;
	undo(): void;
	redo(): void;
	setPending(fn: (() => void) | undefined): void;
}) {
	const [editing, setEditing] = useState<string>();
	const composing = useRef(false);
	useEffect(() => {
		setEditing(undefined);
	}, [value]);
	const finish = (next: string) => {
		setPending(undefined);
		setEditing(undefined);
		commit(next);
	};
	const current = editing ?? value;
	const shared = {
		value: current,
		onCompositionStart: () => {
			composing.current = true;
		},
		onCompositionEnd: () => {
			composing.current = false;
		},
		onBeforeInput: (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			handleHistoryBeforeInput(event, editing !== undefined, undo, redo),
		onChange: (event: { target: { value: string } }) => {
			const next = event.target.value;
			setEditing(next);
			setPending(() => {
				if (!composing.current) {
					setPending(undefined);
					setEditing(undefined);
					commit(next);
				}
			});
		},
		onBlur: () => {
			if (!composing.current && editing !== undefined) {
				finish(editing);
			}
		},
		onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			if (event.nativeEvent.isComposing || composing.current) {
				return;
			}
			if (handleHistoryKey(event, editing !== undefined, undo, redo)) {
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				finish(current);
			}
		},
	};
	return (
		<label className={className ?? 'lore-field'}>
			<span>{label}</span>
			{multiline ? <textarea rows={2} {...shared} /> : <input type="text" {...shared} />}
		</label>
	);
}

export function LoreForm({ data, types, commit, undo, redo, showSource, handleRef }: Props) {
	const pending = useRef<(() => void) | undefined>(undefined);
	const setPending = (fn: (() => void) | undefined) => {
		pending.current = fn;
	};
	handleRef.current = {
		flush: () => {
			pending.current?.();
		},
	};
	useEffect(() => {
		return () => {
			handleRef.current = undefined;
		};
	}, [handleRef]);
	return (
		<div
			className="lore-form"
			onKeyDown={(event) => {
				handleHistoryKey(event, false, undo, redo);
			}}
		>
			<div className="lore-form-inner">
				<div className="lore-form-row">
					<TypeField
						value={data.type}
						types={types}
						commit={(value) => commit('type', value)}
						undo={undo}
						redo={redo}
						setPending={setPending}
					/>
					<TextField
						label={zh.aliases}
						value={data.aliases.join('、')}
						className="lore-field lore-field-aliases"
						commit={(value) => commit('aliases', value)}
						undo={undo}
						redo={redo}
						setPending={setPending}
					/>
					<label className="lore-field lore-field-check">
						<input type="checkbox" checked={data.always} onChange={(event) => commit('always', event.target.checked)} />
						<span>{zh.always}</span>
					</label>
					<button type="button" className="lore-mode-toggle" onClick={showSource}>
						{zh.loreSource}
					</button>
				</div>
				<TextField
					label={zh.summary}
					value={data.summary}
					multiline
					className="lore-field lore-field-summary"
					commit={(value) => commit('summary', value)}
					undo={undo}
					redo={redo}
					setPending={setPending}
				/>
				{data.extras.length > 0 ? (
					<div className="lore-form-extras">
						{data.extras.map((extra) =>
							extra.kind === 'boolean' ? (
								<label key={extra.key} className="lore-field lore-field-extra lore-field-check">
									<input type="checkbox" checked={extra.value as boolean} onChange={(event) => commit(extra.key, event.target.checked)} />
									<span>{extra.key}</span>
								</label>
							) : (
								<TextField
									key={extra.key}
									label={extra.key}
									value={extra.kind === 'list' ? (extra.value as string[]).join(', ') : (extra.value as string)}
									className="lore-field lore-field-extra"
									commit={(value) => commit(extra.key, value)}
									undo={undo}
									redo={redo}
									setPending={setPending}
								/>
							),
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}
