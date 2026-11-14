import { writingPreferences } from './preferences';
import { ConflictBar } from './ConflictBar';
import { LoreForm } from './LoreForm';
import { useDocument } from './useDocument';
import { loreExtension, updateLore } from '../reference/loreExtension';
import { useWorkspace } from '../workspace';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Annotation, ChangeSet, EditorSelection, EditorState, StateEffect, StateField, type Text, Transaction } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory, redo, undo } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { GhostController } from '../ghost/extension';
import { commitLoreField, diffFrontmatterPrefix, inspectLoreForm } from '../../core/loreForm';
import { groupLore } from '../../core/loreGroups';
import { frontmatterLength } from '../../core/text';
import type { Settings, TabState } from '../../shared/api';
import type { DocumentModel } from './document';
import { prose } from './prose';
import { zh } from '../strings';

const formEdit = Annotation.define<boolean>();
const setHideFrontmatter = StateEffect.define<boolean>();
const hideFrontmatter = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHideFrontmatter)) {
				value = effect.value;
			}
		}
		return value;
	},
});

function hiddenFrontmatterEnd(state: EditorState): number {
	if (!state.field(hideFrontmatter)) {
		return 0;
	}
	const text = state.doc.toString();
	const head = frontmatterLength(text);
	if (head > 0) {
		return text[head - 1] === '\n' ? head : 0;
	}
	return text.startsWith('\uFEFF') ? 1 : 0;
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
	const end = hiddenFrontmatterEnd(state);
	if (end === 0) {
		return Decoration.none;
	}
	if (end === 1 && state.doc.sliceString(0, 1) === '\uFEFF') {
		return Decoration.set([Decoration.replace({}).range(0, 1)]);
	}
	return Decoration.set([Decoration.replace({ block: true }).range(0, end - 1)]);
}

const frontmatterDecoration = StateField.define<DecorationSet>({
	create: buildFrontmatterDecorations,
	update(value, tr) {
		if (tr.docChanged || tr.startState.field(hideFrontmatter) !== tr.state.field(hideFrontmatter)) {
			return buildFrontmatterDecorations(tr.state);
		}
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});

function clampSelection(selection: EditorSelection, minPos: number): EditorSelection {
	return EditorSelection.create(
		selection.ranges.map((range) => EditorSelection.range(Math.max(minPos, range.anchor), Math.max(minPos, range.head))),
		selection.mainIndex,
	);
}

const frontmatterGuard = EditorState.transactionFilter.of((tr) => {
	const startGuard = hiddenFrontmatterEnd(tr.startState);
	let touchesHidden = false;
	if (startGuard > 0) {
		tr.changes.iterChanges((fromA) => {
			if (fromA < startGuard) {
				touchesHidden = true;
			}
		});
	}
	if (!touchesHidden) {
		const endGuard = hiddenFrontmatterEnd(tr.state);
		const sel = tr.newSelection;
		if (endGuard > 0 && sel.ranges.some((range) => range.anchor < endGuard || range.head < endGuard)) {
			return [tr, { selection: clampSelection(sel, endGuard) }];
		}
		return tr;
	}
	const specs: { from: number; to: number; insert: Text }[] = [];
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (fromA >= startGuard) {
			specs.push({ from: fromA, to: toA, insert: inserted });
		} else if (toA > startGuard) {
			specs.push({ from: startGuard, to: toA, insert: inserted });
		}
	});
	const changes = ChangeSet.of(specs, tr.startState.doc.length);
	const selection = tr.selection
		? EditorSelection.create(
				tr.selection.ranges.map((range) => {
					const anchor0 = Math.max(startGuard, tr.changes.invertedDesc.mapPos(range.anchor, 1));
					const head0 = Math.max(startGuard, tr.changes.invertedDesc.mapPos(range.head, 1));
					return EditorSelection.range(Math.max(startGuard, changes.mapPos(anchor0, 1)), Math.max(startGuard, changes.mapPos(head0, 1)));
				}),
				tr.selection.mainIndex,
			)
		: EditorSelection.create(
				tr.startState.selection.ranges.map((range) =>
					EditorSelection.range(Math.max(startGuard, changes.mapPos(range.anchor, 1)), Math.max(startGuard, changes.mapPos(range.head, 1))),
				),
				tr.startState.selection.mainIndex,
			);
	const userEvent = tr.annotation(Transaction.userEvent);
	return {
		changes,
		selection,
		effects: StateEffect.mapEffects(StateEffect.mapEffects(tr.effects, tr.changes.invertedDesc), changes),
		annotations: userEvent ? Transaction.userEvent.of(userEvent) : undefined,
		scrollIntoView: tr.scrollIntoView,
	};
});

export interface EditorHandle {
	view: EditorView;
	ghost: GhostController;
	reload(): void;
	find(): void;
	goTo(offset: number): void;
}
interface Props {
	document: DocumentModel;
	tab: TabState;
	active: boolean;
	visible?: boolean;
	side?: 'left' | 'right';
	focused?(): void;
	chapter: boolean;
	settings: Settings;
	limited: boolean;
	nextRequestId(): number;
	ready(handle?: EditorHandle): void;
	cursor(anchor: number, head: number): void;
}
export function Editor({
	document: model,
	tab,
	active,
	chapter,
	settings,
	limited,
	ready,
	cursor,
	nextRequestId,
	visible = active,
	focused,
	side,
}: Props) {
	useDocument(model);
	const workspace = useWorkspace();
	const lore = !model.readOnly && workspace.reference.entries.some((entry) => entry.id === model.path);
	const [sourceMode, setSourceMode] = useState(false);
	const [syncVersion, setSyncVersion] = useState(0);
	const formData = lore ? inspectLoreForm(model.text) : undefined;
	const formActive = lore && !sourceMode && formData !== undefined;
	const types = lore
		? groupLore(workspace.reference.entries)
				.map((group) => group.type)
				.filter(Boolean)
		: [];
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	const callbacksOpen = useRef(workspace.open);
	const entriesRef = useRef(workspace.reference.entries);
	entriesRef.current = workspace.reference.entries;
	callbacksOpen.current = workspace.open;
	const loreRef = useRef(lore);
	loreRef.current = lore;
	const sourceModeRef = useRef(sourceMode);
	sourceModeRef.current = sourceMode;
	const formDataRef = useRef(formData);
	formDataRef.current = formData;
	const parent = useRef<HTMLDivElement>(null);
	const handle = useRef<EditorHandle | undefined>(undefined);
	const callbacks = useRef({ ready, cursor });
	callbacks.current = { ready, cursor };
	useEffect(() => {
		const ghost = new GhostController(model.path, chapter, window.novel, settings.debounceMs, nextRequestId, {
			start: () => model.compositionStart(),
			end: (text) => model.compositionEnd(text),
		});
		const extensions = [
			history(),
			EditorState.readOnly.of(model.readOnly),
			EditorView.editable.of(!model.readOnly),

			ghost.extension(),
			prose,
			writingPreferences(() => settingsRef.current['editor.centerLine']),
			markdown(),
			EditorView.lineWrapping,
			EditorState.phrases.of(zh.search),
			search({ top: true }),
			keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
			EditorView.contentAttributes.of({ 'aria-label': model.path, spellcheck: 'false' }),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					const fromForm = update.transactions.some((tr) => tr.annotation(formEdit));
					if (!fromForm) {
						setSyncVersion((n) => n + 1);
						if (
							!update.state.field(hideFrontmatter) &&
							loreRef.current &&
							!sourceModeRef.current &&
							update.transactions.some((tr) => tr.isUserEvent('input'))
						) {
							setSourceMode(true);
						}
					}
					model.edit(update.state.doc.toString());
				}
				const endGuard = hiddenFrontmatterEnd(update.state);
				if (endGuard > 0 && update.state.selection.ranges.some((range) => range.anchor < endGuard || range.head < endGuard)) {
					queueMicrotask(() => {
						const currentView = handle.current?.view;
						if (!currentView) {
							return;
						}
						const guardNow = hiddenFrontmatterEnd(currentView.state);
						if (guardNow > 0 && currentView.state.selection.ranges.some((range) => range.anchor < guardNow || range.head < guardNow)) {
							currentView.dispatch({
								selection: clampSelection(currentView.state.selection, guardNow),
								annotations: Transaction.addToHistory.of(false),
							});
						}
					});
				}
				if (update.selectionSet || update.docChanged) {
					const selection = update.state.selection.main;
					callbacks.current.cursor(selection.anchor, selection.head);
				}
			}),
		];
		const stateFor = (anchor: number, head: number, hide: boolean) => {
			const minPos = hide ? (formDataRef.current?.prefix.length ?? 0) : 0;
			const clamp = (pos: number) => Math.max(minPos, Math.min(pos, model.text.length));
			return EditorState.create({
				doc: model.text,
				selection: { anchor: clamp(anchor), head: clamp(head) },
				extensions: [
					hideFrontmatter.init(() => hide),
					frontmatterDecoration,
					frontmatterGuard,
					model.readOnly ? [] : loreExtension(entriesRef.current, (path, options) => callbacksOpen.current(path, options)),
					...extensions,
				],
			});
		};
		const initialHide = loreRef.current && !sourceModeRef.current && formDataRef.current !== undefined;
		const view = new EditorView({ parent: parent.current!, state: stateFor(tab.anchor, tab.head, initialHide) });
		ghost.attach(view);
		const instance: EditorHandle = {
			view,
			ghost,
			find: () => {
				openSearchPanel(view);
			},
			goTo: (offset) => {
				const target = Math.max(0, Math.min(offset, view.state.doc.length));
				view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
			},
			reload: () => {},
		};
		// Reload changes are excluded from history; a fresh history starts with the disk version.
		instance.reload = () => {
			ghost.send({ type: 'blur' });
			const selection = view.state.selection.main;
			const nextForm = loreRef.current ? inspectLoreForm(model.text) : undefined;
			formDataRef.current = nextForm;
			const nextHide = loreRef.current && !sourceModeRef.current && nextForm !== undefined;
			view.setState(stateFor(selection.anchor, selection.head, nextHide));
			setSyncVersion((n) => n + 1);
			ghost.attach(view);
			callbacks.current.cursor(view.state.selection.main.anchor, view.state.selection.main.head);
			if (view.hasFocus) {
				ghost.send({ type: 'focus' });
			}
		};
		handle.current = instance;
		callbacks.current.ready(instance);
		return () => {
			callbacks.current.ready(undefined);
			ghost.dispose();
			view.destroy();
		};
	}, [model]);
	useEffect(() => {
		const view = handle.current?.view;
		if (!view || view.state.field(hideFrontmatter) === formActive) {
			return;
		}
		view.dispatch({
			effects: setHideFrontmatter.of(formActive),
			annotations: Transaction.addToHistory.of(false),
		});
	}, [formActive]);
	useEffect(() => {
		handle.current?.ghost.settings(
			settings.enabled && !model.readOnly,
			settings.trigger === 'auto',
			limited,
			settings.debounceMs,
			JSON.stringify(settings),
		);
	}, [settings, limited]);
	useEffect(() => {
		if (active) {
			handle.current?.view.requestMeasure();
			if (!parent.current?.parentElement?.contains(window.document.activeElement)) {
				handle.current?.view.focus();
			}
			if (handle.current) {
				handle.current.view.dispatch({ effects: EditorView.scrollIntoView(handle.current.view.state.selection.main.head) });
			}
		} else {
			handle.current?.ghost.send({ type: 'blur' });
			void model.save();
		}
	}, [active, model]);
	useEffect(() => {
		if (!model.readOnly) {
			handle.current?.view.dispatch({ effects: updateLore.of(workspace.reference.entries) });
		}
	}, [workspace.reference.entries, model]);
	useEffect(() => {
		if (visible) {
			handle.current?.view.requestMeasure();
		}
	}, [visible]);
	const commit = (key: string, raw: string | boolean, discrete = false) => {
		const view = handle.current?.view;
		if (!view) {
			return;
		}
		const docText = view.state.doc.toString();
		const current = inspectLoreForm(docText);
		if (!current) {
			return;
		}
		const nextText = commitLoreField(docText, current, key, raw);
		if (nextText === undefined) {
			return;
		}
		const nextForm = inspectLoreForm(nextText);
		if (!nextForm) {
			return;
		}
		const diff = diffFrontmatterPrefix(current.prefix, nextForm.prefix);
		const changeSet = ChangeSet.of([diff], view.state.doc.length);
		const minPos = nextForm.prefix.length;
		const selection = EditorSelection.create(
			view.state.selection.ranges.map((range) =>
				EditorSelection.range(Math.max(minPos, changeSet.mapPos(range.anchor, 1)), Math.max(minPos, changeSet.mapPos(range.head, 1))),
			),
			view.state.selection.mainIndex,
		);
		formDataRef.current = nextForm;
		view.dispatch({
			changes: changeSet,
			selection,
			filter: false,
			userEvent: discrete ? 'input' : 'input.type',
			annotations: discrete ? [formEdit.of(true), isolateHistory.of('full')] : formEdit.of(true),
		});
	};
	return (
		<div
			className={`editor-pane pane-${side}${formActive ? ' has-lore-form' : ''}`}
			onFocus={focused}
			style={
				{
					display: visible ? undefined : 'none',
					'--writing-font': settings['editor.fontFamily'],
					'--writing-size': `${settings['editor.fontSize']}px`,
				} as CSSProperties
			}
		>
			<ConflictBar document={model} reload={() => handle.current?.reload()} />
			{formActive && formData ? (
				<LoreForm
					data={formData}
					types={types}
					syncVersion={syncVersion}
					commit={commit}
					compositionStart={() => model.compositionStart()}
					compositionEnd={() => {
						const view = handle.current?.view;
						model.compositionEnd(view ? view.state.doc.toString() : model.text);
					}}
					undo={() => {
						if (handle.current) {
							undo(handle.current.view);
						}
					}}
					redo={() => {
						if (handle.current) {
							redo(handle.current.view);
						}
					}}
					showSource={() => {
						setSourceMode(true);
						queueMicrotask(() => handle.current?.view.focus());
					}}
				/>
			) : lore && sourceMode && formData ? (
				<button
					type="button"
					className="lore-mode-toggle floating"
					style={model.conflict !== undefined || model.error ? { top: '44px' } : undefined}
					onClick={() => setSourceMode(false)}
				>
					{zh.loreForm}
				</button>
			) : null}
			<div className={`editor ${settings['editor.centerLine'] ? 'center-line' : ''}`} ref={parent} />
		</div>
	);
}
