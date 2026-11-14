import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { LoreFormData } from '../../core/loreForm';
import { zh } from '../strings';

interface Props {
	data: LoreFormData;
	types: readonly string[];
	syncVersion: number;
	commit(key: string, value: string | boolean, discrete?: boolean): void;
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
	syncVersion,
	commit,
	compositionStart,
	compositionEnd,
	undo,
	redo,
}: {
	value: string;
	types: readonly string[];
	syncVersion: number;
	commit(value: string, discrete?: boolean): void;
	compositionStart(): void;
	compositionEnd(): void;
	undo(): void;
	redo(): void;
}) {
	const [rawText, setRawText] = useState<string>();
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const composing = useRef(false);
	const finishComposition = useRef(compositionEnd);
	finishComposition.current = compositionEnd;
	const boxRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
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
	const choose = (option: string) => {
		setRawText(undefined);
		setOpen(false);
		setActiveIndex(-1);
		commit(option, true);
	};
	const current = rawText ?? value;
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
					onCompositionStart={(event) => {
						composing.current = true;
						setRawText(event.currentTarget.value);
						compositionStart();
					}}
					onCompositionEnd={(event) => {
						if (!composing.current) {
							return;
						}
						composing.current = false;
						const next = event.currentTarget.value;
						setRawText(next);
						commit(next, false);
						compositionEnd();
					}}
					onBeforeInput={(event) => {
						if (!composing.current) {
							handleHistoryBeforeInput(event, undo, redo);
						}
					}}
					onChange={(event) => {
						const next = event.target.value;
						setRawText(next);
						setActiveIndex(-1);
						if (!composing.current) {
							commit(next, false);
						}
					}}
					onBlur={() => {
						if (composing.current) {
							return;
						}
						setRawText(undefined);
						setOpen(false);
						setActiveIndex(-1);
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing || composing.current) {
							return;
						}
						if (handleHistoryKey(event, undo, redo)) {
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
								choose(types[activeIndex]);
							} else {
								setOpen(false);
								setActiveIndex(-1);
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
								onClick={() => choose(option)}
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
	keepRawWhileFocused = false,
	syncVersion,
	className,
	commit,
	compositionStart,
	compositionEnd,
	undo,
	redo,
}: {
	label: string;
	value: string;
	multiline?: boolean;
	keepRawWhileFocused?: boolean;
	syncVersion: number;
	className?: string;
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
			setRawText(keepRawWhileFocused ? next : undefined);
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
			if (keepRawWhileFocused) {
				setRawText(next);
			}
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
			if (keepRawWhileFocused) {
				setRawText(next);
			}
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
		<label className={className ?? 'lore-field'}>
			<span>{label}</span>
			{multiline ? <textarea rows={2} {...shared} /> : <input type="text" {...shared} />}
		</label>
	);
}

export function LoreForm({ data, types, syncVersion, commit, compositionStart, compositionEnd, undo, redo, showSource }: Props) {
	return (
		<div
			className="lore-form"
			onKeyDown={(event) => {
				handleHistoryKey(event, undo, redo);
			}}
		>
			<div className="lore-form-inner">
				<div className="lore-form-row">
					<TypeField
						value={data.type}
						types={types}
						syncVersion={syncVersion}
						commit={(value, discrete) => commit('type', value, discrete)}
						compositionStart={compositionStart}
						compositionEnd={compositionEnd}
						undo={undo}
						redo={redo}
					/>
					<TextField
						label={zh.aliases}
						value={data.aliases.join('、')}
						keepRawWhileFocused
						syncVersion={syncVersion}
						className="lore-field lore-field-aliases"
						commit={(value) => commit('aliases', value)}
						compositionStart={compositionStart}
						compositionEnd={compositionEnd}
						undo={undo}
						redo={redo}
					/>
					<label className="lore-field lore-field-check">
						<input type="checkbox" checked={data.always} onChange={(event) => commit('always', event.target.checked, true)} />
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
					syncVersion={syncVersion}
					className="lore-field lore-field-summary"
					commit={(value) => commit('summary', value)}
					compositionStart={compositionStart}
					compositionEnd={compositionEnd}
					undo={undo}
					redo={redo}
				/>
				{data.extras.length > 0 ? (
					<div className="lore-form-extras">
						{data.extras.map((extra) =>
							extra.kind === 'boolean' ? (
								<label key={extra.key} className="lore-field lore-field-extra lore-field-check">
									<input
										type="checkbox"
										checked={extra.value as boolean}
										onChange={(event) => commit(extra.key, event.target.checked, true)}
									/>
									<span>{extra.key}</span>
								</label>
							) : (
								<TextField
									key={extra.key}
									label={extra.key}
									value={extra.kind === 'list' ? (extra.value as string[]).join(', ') : (extra.value as string)}
									keepRawWhileFocused={extra.kind === 'list'}
									syncVersion={syncVersion}
									className="lore-field lore-field-extra"
									commit={(value) => commit(extra.key, value)}
									compositionStart={compositionStart}
									compositionEnd={compositionEnd}
									undo={undo}
									redo={redo}
								/>
							),
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}
