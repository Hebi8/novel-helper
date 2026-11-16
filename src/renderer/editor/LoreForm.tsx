import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { appendLoreListItems, hasLoreListSeparator, type LoreFormData } from '../../core/loreForm';
import { zh } from '../strings';

interface Props {
	title: string;
	data: LoreFormData;
	types: readonly string[];
	syncVersion: number;
	commit(key: string, value: string | boolean | readonly string[], discrete?: boolean): void;
	compositionStart(): void;
	compositionEnd(): void;
	undo(): void;
	redo(): void;
	showSource(): void;
}

function handleHistoryKey(event: KeyboardEvent<HTMLElement>, undo: () => void, redo: () => void): boolean {
	if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z' && !event.nativeEvent.isComposing) {
		event.preventDefault();
		event.stopPropagation();
		if (event.shiftKey) {
			redo();
		} else {
			undo();
		}
		return true;
	}
	return false;
}

function handleHistoryBeforeInput(event: FormEvent<HTMLElement>, undo: () => void, redo: () => void): void {
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
	compositionStart,
	compositionEnd,
	undo,
	redo,
}: {
	value: string;
	types: readonly string[];
	commit(value: string, discrete?: boolean): void;
	compositionStart(): void;
	compositionEnd(): void;
	undo(): void;
	redo(): void;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState('');
	const [activeIndex, setActiveIndex] = useState(-1);
	const composing = useRef(false);
	const finishComposition = useRef(compositionEnd);
	finishComposition.current = compositionEnd;
	const boxRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const id = useId();

	useEffect(
		() => () => {
			if (composing.current) {
				composing.current = false;
				finishComposition.current();
			}
		},
		[],
	);

	const closeMenu = useCallback(() => {
		setOpen(false);
		setDraft('');
		setActiveIndex(-1);
		setTimeout(() => triggerRef.current?.focus(), 0);
	}, []);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape' && !event.isComposing && !composing.current) {
				event.preventDefault();
				event.stopPropagation();
				closeMenu();
			}
		};
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && !boxRef.current?.contains(target)) {
				closeMenu();
			}
		};
		window.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('mousedown', onMouseDown, true);
		return () => {
			window.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('mousedown', onMouseDown, true);
		};
	}, [open, closeMenu]);

	const choose = (option: string) => {
		setOpen(false);
		setDraft('');
		setActiveIndex(-1);
		commit(option, true);
		setTimeout(() => triggerRef.current?.focus(), 0);
	};

	return (
		<>
			<div className="lore-prop-key">
				<label htmlFor={id}>{zh.loreType}</label>
			</div>
			<div
				className="lore-prop-val"
				onClick={(event) => {
					if (event.target === event.currentTarget) {
						setOpen((was) => {
							if (was) {
								setDraft('');
								setActiveIndex(-1);
							}
							return !was;
						});
						triggerRef.current?.focus();
					}
				}}
			>
				<div className="lore-type-box" ref={boxRef}>
					<button
						ref={triggerRef}
						id={id}
						type="button"
						className="lore-type-pill"
						aria-haspopup="listbox"
						aria-expanded={open}
						onClick={() => {
							setOpen((was) => {
								if (was) {
									setDraft('');
									setActiveIndex(-1);
								}
								return !was;
							});
						}}
						onKeyDown={(event) => {
							if (handleHistoryKey(event, undo, redo)) {
								return;
							}
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								if (!open) {
									setOpen(true);
									setActiveIndex(types.length > 0 ? 0 : -1);
									if (types.length === 0) {
										requestAnimationFrame(() => inputRef.current?.focus());
									}
								} else if (activeIndex + 1 < types.length) {
									setActiveIndex(activeIndex + 1);
								} else {
									setActiveIndex(-1);
									inputRef.current?.focus();
								}
								return;
							}
							if (event.key === 'ArrowUp' && open && types.length > 0) {
								event.preventDefault();
								setActiveIndex((index) => (index <= 0 ? types.length - 1 : index - 1));
								return;
							}
							if (event.key === 'Enter' && open && activeIndex >= 0 && activeIndex < types.length) {
								event.preventDefault();
								choose(types[activeIndex]);
							}
						}}
					>
						<span className={value ? undefined : 'lore-placeholder'}>{value || zh.ungrouped}</span>
						<span className="lore-type-chev" aria-hidden="true">
							▾
						</span>
					</button>
					{open ? (
						<div className="lore-type-menu" role="listbox">
							{types.length > 0 ? (
								<div className="lore-type-options">
									{types.map((option, index) => (
										<button
											key={option}
											type="button"
											role="option"
											aria-selected={option === value}
											className={index === activeIndex ? 'lore-type-option active' : 'lore-type-option'}
											onMouseDown={(event) => event.preventDefault()}
											onClick={() => choose(option)}
										>
											<span>{option}</span>
											{option === value ? (
												<span className="lore-type-check" aria-hidden="true">
													✓
												</span>
											) : null}
										</button>
									))}
								</div>
							) : null}
							{types.length > 0 ? <hr /> : null}
							<input
								ref={inputRef}
								type="text"
								className="lore-type-input"
								placeholder={zh.newTypePlaceholder}
								aria-label={zh.newTypePlaceholder}
								value={draft}
								onCompositionStart={() => {
									composing.current = true;
									compositionStart();
								}}
								onCompositionEnd={() => {
									if (composing.current) {
										composing.current = false;
										compositionEnd();
									}
								}}
								onBeforeInput={(event) => {
									if (!composing.current) {
										handleHistoryBeforeInput(event, undo, redo);
									}
								}}
								onChange={(event) => {
									setDraft(event.target.value);
									setActiveIndex(-1);
								}}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing || composing.current) {
										return;
									}
									if (handleHistoryKey(event, undo, redo)) {
										return;
									}
									if (event.key === 'Enter') {
										event.preventDefault();
										event.stopPropagation();
										const next = draft.trim();
										if (next) {
											choose(next);
										}
									}
								}}
							/>
						</div>
					) : null}
				</div>
			</div>
		</>
	);
}

function PillListField({
	fieldKey,
	label,
	items,
	syncVersion,
	commit,
	compositionStart,
	compositionEnd,
	undo,
	redo,
}: {
	fieldKey: string;
	label: string;
	items: readonly string[];
	syncVersion: number;
	commit(items: readonly string[], discrete?: boolean): void;
	compositionStart(): void;
	compositionEnd(): void;
	undo(): void;
	redo(): void;
}) {
	const [draft, setDraft] = useState('');
	const composing = useRef(false);
	const finishComposition = useRef(compositionEnd);
	finishComposition.current = compositionEnd;
	const inputRef = useRef<HTMLInputElement>(null);
	const id = useId();

	useEffect(() => {
		setDraft('');
	}, [syncVersion]);

	useEffect(
		() => () => {
			if (composing.current) {
				composing.current = false;
				finishComposition.current();
			}
		},
		[],
	);

	return (
		<>
			<div className="lore-prop-key">
				<label htmlFor={id}>{label}</label>
			</div>
			<div
				className="lore-prop-val"
				onClick={(event) => {
					if (event.target === event.currentTarget) {
						inputRef.current?.focus();
					}
				}}
			>
				{items.map((item, index) => (
					<span key={item} className="lore-pill">
						<span>{item}</span>
						<button
							type="button"
							className="lore-pill-remove"
							aria-label={zh.removeItem(item)}
							onClick={() => {
								commit(
									items.filter((_, current) => current !== index),
									true,
								);
								inputRef.current?.focus();
							}}
						>
							✕
						</button>
					</span>
				))}
				<input
					ref={inputRef}
					id={id}
					type="text"
					className="lore-pill-input"
					placeholder={zh.addAlias}
					value={draft}
					onCompositionStart={() => {
						composing.current = true;
						compositionStart();
					}}
					onCompositionEnd={() => {
						if (composing.current) {
							composing.current = false;
							compositionEnd();
						}
					}}
					onBeforeInput={(event) => {
						if (!composing.current) {
							handleHistoryBeforeInput(event, undo, redo);
						}
					}}
					onChange={(event) => setDraft(event.target.value)}
					onPaste={(event) => {
						const pasted = event.clipboardData.getData('text/plain');
						if (!hasLoreListSeparator(pasted, fieldKey)) {
							return;
						}
						event.preventDefault();
						const target = event.currentTarget;
						const start = target.selectionStart ?? draft.length;
						const end = target.selectionEnd ?? start;
						const combined = draft.slice(0, start) + pasted + draft.slice(end);
						const next = appendLoreListItems(items, combined, fieldKey);
						setDraft('');
						if (next.length !== items.length) {
							commit(next, true);
						}
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing || composing.current) {
							return;
						}
						if (handleHistoryKey(event, undo, redo)) {
							return;
						}
						if (event.key === 'Enter') {
							event.preventDefault();
							const next = appendLoreListItems(items, draft, fieldKey);
							setDraft('');
							if (next.length !== items.length) {
								commit(next, true);
							}
						}
					}}
				/>
			</div>
		</>
	);
}

function SwitchField({ label, checked, commit }: { label: string; checked: boolean; commit(value: boolean): void }) {
	const id = useId();
	return (
		<>
			<div className="lore-prop-key">
				<label htmlFor={id}>{label}</label>
			</div>
			<div className="lore-prop-val">
				<button
					id={id}
					type="button"
					role="switch"
					aria-checked={checked}
					className={checked ? 'lore-switch on' : 'lore-switch'}
					onClick={() => commit(!checked)}
				/>
			</div>
		</>
	);
}

function InlineTextField({
	label,
	value,
	placeholder,
	multiline = false,
	syncVersion,
	commit,
	compositionStart,
	compositionEnd,
	undo,
	redo,
}: {
	label: string;
	value: string;
	placeholder?: string;
	multiline?: boolean;
	syncVersion: number;
	commit(value: string): void;
	compositionStart(): void;
	compositionEnd(): void;
	undo(): void;
	redo(): void;
}) {
	const [rawText, setRawText] = useState<string>();
	const composing = useRef(false);
	const finishComposition = useRef(compositionEnd);
	finishComposition.current = compositionEnd;
	const inputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const id = useId();

	useEffect(() => {
		setRawText(undefined);
	}, [syncVersion]);

	useEffect(
		() => () => {
			if (composing.current) {
				composing.current = false;
				finishComposition.current();
			}
		},
		[],
	);

	const shared = {
		id,
		placeholder,
		value: rawText ?? value,
		onCompositionStart: (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			composing.current = true;
			setRawText(event.currentTarget.value);
			compositionStart();
		},
		onCompositionEnd: (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			if (!composing.current) {
				return;
			}
			composing.current = false;
			const next = event.currentTarget.value.replace(/(?:\r\n|\r|\n)+/g, ' ');
			setRawText(next);
			commit(next);
			compositionEnd();
		},
		onBeforeInput: (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			if (!composing.current) {
				handleHistoryBeforeInput(event, undo, redo);
			}
		},
		onPaste: (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			const pasted = event.clipboardData.getData('text/plain');
			if (!/[\r\n]/.test(pasted)) {
				return;
			}
			event.preventDefault();
			const target = event.currentTarget;
			const clean = pasted.replace(/(?:\r\n|\r|\n)+/g, ' ');
			const start = target.selectionStart ?? target.value.length;
			const end = target.selectionEnd ?? start;
			const next = target.value.slice(0, start) + clean + target.value.slice(end);
			setRawText(next);
			commit(next);
			const caret = start + clean.length;
			requestAnimationFrame(() => {
				if (document.activeElement === target) {
					target.setSelectionRange(caret, caret);
				}
			});
		},
		onChange: (event: { target: { value: string } }) => {
			if (composing.current) {
				setRawText(event.target.value);
				return;
			}
			const next = event.target.value.replace(/(?:\r\n|\r|\n)+/g, ' ');
			setRawText(next);
			commit(next);
		},
		onBlur: () => {
			if (!composing.current) {
				setRawText(undefined);
			}
		},
		onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			if (event.nativeEvent.isComposing || composing.current) {
				return;
			}
			if (handleHistoryKey(event, undo, redo)) {
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
			}
		},
	};

	return (
		<>
			<div className="lore-prop-key">
				<label htmlFor={id}>{label}</label>
			</div>
			<div
				className="lore-prop-val"
				onClick={(event) => {
					if (event.target === event.currentTarget) {
						(multiline ? textareaRef.current : inputRef.current)?.focus();
					}
				}}
			>
				{multiline ? (
					<textarea ref={textareaRef} rows={1} className="lore-inline-textarea" {...shared} />
				) : (
					<input ref={inputRef} type="text" className="lore-inline-input" {...shared} />
				)}
			</div>
		</>
	);
}

export function LoreForm({ title, data, types, syncVersion, commit, compositionStart, compositionEnd, undo, redo, showSource }: Props) {
	return (
		<div
			className="lore-form"
			onKeyDown={(event) => {
				handleHistoryKey(event, undo, redo);
			}}
		>
			<div className="lore-title-row">
				<h2>{title}</h2>
				<button type="button" className="lore-mode-toggle" onClick={showSource}>
					{zh.loreSource}
				</button>
			</div>
			<div className="lore-props">
				<TypeField
					value={data.type}
					types={types}
					commit={(value, discrete) => commit('type', value, discrete)}
					compositionStart={compositionStart}
					compositionEnd={compositionEnd}
					undo={undo}
					redo={redo}
				/>
				<PillListField
					fieldKey="aliases"
					label={zh.aliases}
					items={data.aliases}
					syncVersion={syncVersion}
					commit={(items, discrete) => commit('aliases', items, discrete)}
					compositionStart={compositionStart}
					compositionEnd={compositionEnd}
					undo={undo}
					redo={redo}
				/>
				<SwitchField label={zh.always} checked={data.always} commit={(value) => commit('always', value, true)} />
				<InlineTextField
					label={zh.summary}
					value={data.summary}
					placeholder={zh.addSummary}
					multiline
					syncVersion={syncVersion}
					commit={(value) => commit('summary', value)}
					compositionStart={compositionStart}
					compositionEnd={compositionEnd}
					undo={undo}
					redo={redo}
				/>
				{data.extras.map((extra) =>
					extra.kind === 'boolean' ? (
						<SwitchField
							key={extra.key}
							label={extra.key}
							checked={extra.value as boolean}
							commit={(value) => commit(extra.key, value, true)}
						/>
					) : extra.kind === 'list' ? (
						<PillListField
							key={extra.key}
							fieldKey={extra.key}
							label={extra.key}
							items={extra.value as string[]}
							syncVersion={syncVersion}
							commit={(items, discrete) => commit(extra.key, items, discrete)}
							compositionStart={compositionStart}
							compositionEnd={compositionEnd}
							undo={undo}
							redo={redo}
						/>
					) : (
						<InlineTextField
							key={extra.key}
							label={extra.key}
							value={extra.value as string}
							syncVersion={syncVersion}
							commit={(value) => commit(extra.key, value)}
							compositionStart={compositionStart}
							compositionEnd={compositionEnd}
							undo={undo}
							redo={redo}
						/>
					),
				)}
			</div>
			<hr className="lore-rule" />
		</div>
	);
}
