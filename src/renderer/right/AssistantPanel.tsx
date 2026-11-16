import { useCallback, useEffect, useRef, useState } from 'react';
import type { SnapshotRecord } from '../../core/snapshot';
import type { Blocked } from '../../storage/snapshotStore';
import type { AssistantEvent, AssistantState } from '../../shared/assistant';
import { useWorkspace } from '../workspace';
import { zh } from '../strings';
import { errorMessage } from '../errors';
import { assistantContext } from '../assistant/context';
import { useEditorContext } from '../assistant/useEditorContext';
import { assistantEvents, type DiffView } from '../assistant/events';
import { DiffOverlay } from '../assistant/DiffOverlay';
import { Overlay } from '../assistant/Overlay';
import { Changes } from '../assistant/Changes';
import { TranscriptItem } from '../assistant/TranscriptItem';
import { applyAssistantEvent } from '../assistant/state';

type RevertMode = 'turn' | 'undo' | 'timed';
type Modal =
	| { kind: 'history' }
	| { kind: 'confirm'; record: number; mode: RevertMode; history: boolean }
	| { kind: 'diff'; diff: DiffView; history: boolean }
	| { kind: 'blocked'; files: Blocked[] };

export function AssistantPanel({ visible = true }: { visible?: boolean }) {
	const workspace = useWorkspace();
	const [state, setState] = useState<AssistantState>({ items: [], busy: false, status: '', options: [] });
	const [hydrated, setHydrated] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [draft, setDraft] = useState('');
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [modal, setModal] = useState<Modal>();
	const [history, setHistory] = useState<SnapshotRecord[]>([]);
	const panel = useRef<HTMLElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const popover = useRef<HTMLDivElement>(null);
	const log = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	const sendGeneration = useRef(0);
	const stoppedBeforeSend = useRef(false);
	const atBottom = useRef(true);
	const busy = state.busy || saving || resetting;
	const { context, refresh: refreshContext } = useEditorContext(workspace);
	const showError = useCallback(
		(message: string) => {
			if (panel.current && !panel.current.offsetParent) {
				workspace.fail(message);
			} else {
				setError(message);
			}
		},
		[workspace],
	);
	const run = useCallback(
		(operation: Promise<unknown>) => {
			void operation.catch((error) => showError(errorMessage(error)));
		},
		[showError],
	);
	const closePicker = useCallback(() => {
		setPickerOpen(false);
		setTimeout(() => input.current?.focus(), 0);
	}, []);
	const openHistory = async () => {
		setHistory((await window.novel.assistant.history()).reverse());
		setModal({ kind: 'history' });
	};

	const stop = () => {
		stoppedBeforeSend.current = true;
		run(window.novel.assistant.stop());
	};
	const newSession = () => {
		sendGeneration.current++;
		setResetting(true);
		setDraft('');
		setError('');
		run(window.novel.assistant.newSession().finally(() => setResetting(false)));
	};

	useEffect(() => {
		let alive = true;
		let ready = false;
		const pending: AssistantEvent[] = [];
		const unsubscribe = window.novel.assistant.onChanged((event) => {
			if (ready) {
				setState((state) => applyAssistantEvent(state, event));
			} else {
				pending.push(event);
			}
		});
		void window.novel.assistant
			.state()
			.then((next) => {
				if (alive) {
					setState(pending.reduce(applyAssistantEvent, next));
					ready = true;
					setHydrated(true);
				}
			})
			.catch((error) => {
				if (alive) {
					setError(errorMessage(error));
				}
			});
		const focus = () => {
			requestAnimationFrame(() => input.current?.focus());
		};
		const history = () => {
			run(openHistory());
		};
		const diff = (event: Event) => {
			setModal({ kind: 'diff', diff: (event as CustomEvent<DiffView>).detail, history: false });
		};
		window.addEventListener(assistantEvents.focus, focus);
		window.addEventListener(assistantEvents.stop, stop);
		window.addEventListener(assistantEvents.history, history);
		window.addEventListener(assistantEvents.diff, diff);
		return () => {
			alive = false;
			unsubscribe();
			window.removeEventListener(assistantEvents.focus, focus);
			window.removeEventListener(assistantEvents.stop, stop);
			window.removeEventListener(assistantEvents.history, history);
			window.removeEventListener(assistantEvents.diff, diff);
		};
	}, []);
	useEffect(() => {
		if (hydrated && visible && !state.options.length && !state.probing && !busy) {
			run(window.novel.assistant.probe());
		}
	}, [hydrated, visible, state.options.length, state.probing, busy, run]);
	useEffect(() => {
		if (!hydrated || !visible) {
			return;
		}
		return window.novel.settings.onChanged(() => {
			run(window.novel.assistant.probe());
		});
	}, [hydrated, visible, run]);
	useEffect(() => {
		if (!pickerOpen) {
			return;
		}
		if (busy || !state.options.length || !visible) {
			setPickerOpen(false);
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				closePicker();
			}
		};
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && !popover.current?.contains(target) && !trigger.current?.contains(target)) {
				closePicker();
			}
		};
		window.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('mousedown', onMouseDown, true);
		return () => {
			window.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('mousedown', onMouseDown, true);
		};
	}, [pickerOpen, busy, state.options.length, visible, closePicker]);
	useEffect(() => {
		if (atBottom.current && log.current) {
			log.current.scrollTop = log.current.scrollHeight;
		}
	}, [state]);

	const send = async () => {
		if (busy || !draft.trim() || composing.current) {
			return;
		}
		const generation = ++sendGeneration.current;
		stoppedBeforeSend.current = false;
		const text = draft;
		setSaving(true);
		setError('');
		try {
			if (!(await workspace.saveAll())) {
				setError(zh.assistantSaveFailed);
				return;
			}
			if (generation !== sendGeneration.current || stoppedBeforeSend.current) {
				return;
			}
			setDraft((current) => (current === text ? '' : current));
			atBottom.current = true;
			const sent = await window.novel.assistant.send(text, assistantContext(workspace.current()));
			if (!sent && generation === sendGeneration.current) {
				setDraft((current) => current || text);
			}
		} catch (error) {
			if (generation === sendGeneration.current) {
				setDraft((current) => current || text);
				setError(errorMessage(error));
			}
		} finally {
			setSaving(false);
		}
	};
	const revert = async (record: number) => {
		setSaving(true);
		setError('');
		try {
			if (!(await workspace.saveAll())) {
				showError(zh.assistantSaveFailed);
				setModal(undefined);
				return;
			}
			const result = await window.novel.assistant.revert(record);
			setModal(result.blocked.length ? { kind: 'blocked', files: result.blocked } : undefined);
		} catch (error) {
			showError(errorMessage(error));
			setModal(undefined);
		} finally {
			setSaving(false);
		}
	};
	const askRevert = useCallback((record: number, mode: RevertMode) => {
		setModal((modal) => ({ kind: 'confirm', record, mode, history: modal?.kind === 'history' }));
	}, []);
	const showDiff = useCallback(
		(record: number, path: string) => {
			run(
				window.novel.assistant.diff(record, path).then((value) => {
					const view: DiffView = value.timed ? { ...value, beforeLabel: zh.snapshotBefore, afterLabel: zh.snapshotAfter } : value;
					setModal((modal) => ({ kind: 'diff', diff: view, history: modal?.kind === 'history' }));
				}),
			);
		},
		[run],
	);
	const answer = useCallback((id: string, allow: boolean) => run(window.novel.assistant.answer(id, allow)), [run]);
	const modelOption = state.options.find((option) => option.category === 'model');
	const effortOption = state.options.find((option) => option.category === 'thought_level');
	const optionLabel = [modelOption, effortOption]
		.flatMap((option) => (option ? [option.values.find((entry) => entry.value === option.value)?.name ?? option.value] : []))
		.join(' ');
	return (
		<>
			<section className="assistant-panel" aria-label={zh.assistant} ref={panel}>
				<header className="assistant-heading">
					<strong>{zh.assistant}</strong>
					<button disabled={resetting || (saving && !state.busy)} onClick={newSession}>
						{zh.assistantNewSession}
					</button>
				</header>
				<div
					className="assistant-log"
					ref={log}
					role="log"
					aria-label={zh.assistantConversation}
					onScroll={() => {
						const element = log.current!;
						atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
					}}
				>
					{state.items.map((item, i) => (
						<TranscriptItem key={i} item={item} busy={busy} diff={showDiff} revert={askRevert} answer={answer} />
					))}
				</div>
				{error ? (
					<div className="assistant-notice error" role="alert">
						{error}
						<button aria-label={zh.dismiss} onClick={() => setError('')}>
							×
						</button>
					</div>
				) : null}
				{state.status ? (
					<div className="assistant-status" role="status">
						{state.status}
					</div>
				) : null}
				<div className="assistant-composer">
					{pickerOpen && state.options.length > 0 && !busy ? (
						<div className="assistant-option-popover" ref={popover} role="dialog" aria-label={zh.model}>
							{modelOption ? (
								<div className="assistant-model-list">
									{modelOption.values.map((entry) => {
										const selected = entry.value === modelOption.value;
										return (
											<button
												type="button"
												key={entry.value}
												className="assistant-model-item"
												aria-pressed={selected}
												onClick={() => {
													run(window.novel.assistant.setOption(modelOption.id, entry.value));
													closePicker();
												}}
											>
												<span className="assistant-model-text">
													<span>{entry.name}</span>
													{entry.description ? <small>{entry.description}</small> : null}
												</span>
												{selected ? (
													<span className="assistant-model-check" aria-hidden="true">
														✓
													</span>
												) : null}
											</button>
										);
									})}
								</div>
							) : null}
							{effortOption ? (
								<div className="assistant-effort-row">
									<span className="assistant-effort-label">{zh.assistantEffort}</span>
									<div className="assistant-effort-segments" role="group" aria-label={zh.assistantEffort}>
										{effortOption.values.map((entry) => (
											<button
												type="button"
												key={entry.value}
												aria-pressed={entry.value === effortOption.value}
												onClick={() => {
													run(window.novel.assistant.setOption(effortOption.id, entry.value));
												}}
											>
												{entry.name}
											</button>
										))}
									</div>
								</div>
							) : null}
						</div>
					) : null}
					{context ? (
						<div className="assistant-context" title={context.path}>
							{zh.assistantContext}：{context.path.split('/').at(-1)} · {zh.assistantLine(context.line)}
							{context.selection
								? ` · ${zh.assistantSelected([...context.selection.text].length)} ${context.selection.text.slice(0, 24)}`
								: ''}
						</div>
					) : null}
					<textarea
						ref={input}
						onFocus={refreshContext}
						rows={3}
						aria-label={zh.assistantInput}
						placeholder={zh.assistantPlaceholder}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							composing.current = false;
						}}
						onKeyDown={(event) => {
							if (
								event.key === 'Enter' &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing &&
								!composing.current &&
								event.keyCode !== 229
							) {
								event.preventDefault();
								void send();
							}
						}}
					/>
					<div className="assistant-actions">
						{state.options.length > 0 ? (
							<button
								type="button"
								ref={trigger}
								className="assistant-option-trigger"
								aria-haspopup="dialog"
								aria-expanded={pickerOpen}
								disabled={busy}
								onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}
							>
								{optionLabel}
							</button>
						) : state.probing ? (
							<button type="button" className="assistant-option-trigger placeholder" disabled />
						) : null}
						{busy ? (
							<button disabled={resetting} onClick={stop}>
								{zh.assistantStop}
							</button>
						) : (
							<button
								disabled={busy || !draft.trim()}
								onClick={() => {
									void send();
								}}
							>
								{zh.assistantSend}
							</button>
						)}
					</div>
				</div>
			</section>
			{modal?.kind === 'diff' ? (
				<DiffOverlay
					diff={modal.diff}
					close={() => setModal(modal.history ? { kind: 'history' } : undefined)}
					open={(path) => {
						run(workspace.open(path));
						setModal(undefined);
					}}
				/>
			) : null}
			{modal?.kind === 'history' ? (
				<Overlay title={zh.assistantSnapshots} close={() => setModal(undefined)}>
					<div className="assistant-history">
						{history.length ? (
							history.map((record) => {
								const mode: RevertMode =
									record.kind === 'revert' ? 'undo' : record.kind === 'timed' || record.kind === 'conflict' ? 'timed' : 'turn';
								return (
									<article className="assistant-turn" key={record.id}>
										<strong>
											{record.kind === 'timed'
												? `${zh.snapshotTimed} · ${(record.changes ?? []).length} ${zh.assistantFiles}`
												: record.kind === 'conflict'
													? `${zh.snapshotConflict} · ${record.title}`
													: `#${record.id} · ${record.kind === 'revert' ? zh.assistantUndoRevert : record.title}`}
										</strong>
										<time>{new Date(record.time).toLocaleString('zh-CN')}</time>
										<Changes changes={record.changes ?? []} record={record.id} diff={showDiff} />
										<button disabled={busy} onClick={() => askRevert(record.id, mode)}>
											{mode === 'undo' ? zh.assistantUndoRevert : mode === 'timed' ? zh.snapshotRevert : zh.assistantRevert}
										</button>
									</article>
								);
							})
						) : (
							<p>{zh.assistantNoSnapshots}</p>
						)}
					</div>
				</Overlay>
			) : null}
			{modal?.kind === 'confirm' ? (
				<Overlay
					title={modal.mode === 'undo' ? zh.assistantUndoRevert : modal.mode === 'timed' ? zh.snapshotRevert : zh.assistantRevert}
					close={() => {
						if (!saving) {
							setModal(modal.history ? { kind: 'history' } : undefined);
						}
					}}
				>
					<div className="assistant-confirm">
						<p>{modal.mode === 'timed' ? zh.snapshotRevertConfirm : zh.assistantRevertConfirm}</p>
						<div className="assistant-actions">
							<button disabled={saving} onClick={() => setModal(modal.history ? { kind: 'history' } : undefined)}>
								{zh.cancel}
							</button>
							<button
								disabled={busy}
								onClick={() => {
									void revert(modal.record);
								}}
							>
								{zh.assistantConfirmRevert}
							</button>
						</div>
					</div>
				</Overlay>
			) : null}
			{modal?.kind === 'blocked' ? (
				<Overlay title={zh.assistantBlocked} close={() => setModal(undefined)}>
					<div className="assistant-confirm">
						<p>{zh.assistantBlockedDetail}</p>
						<ul>
							{modal.files.map((file) => (
								<li key={file.path}>
									{file.path}：{zh.assistantBlockReasons[file.why]}
								</li>
							))}
						</ul>
					</div>
				</Overlay>
			) : null}
		</>
	);
}
