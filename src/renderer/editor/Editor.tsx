import { writingPreferences } from './preferences';
import { ConflictBar } from './ConflictBar';
import { LoreForm, type LoreFormHandle } from './LoreForm';
import { useDocument } from './useDocument';
import { loreExtension, updateLore } from '../reference/loreExtension';
import { useWorkspace } from '../workspace';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Annotation, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, invertedEffects, isolateHistory, redo, undo } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { GhostController } from '../ghost/extension';
import { commitLoreField, inspectLoreForm, type LoreFormData } from '../../core/loreForm';
import { groupLore } from '../../core/loreGroups';
import { frontmatterLength } from '../../core/text';
import type { Settings, TabState } from '../../shared/api';
import type { DocumentModel } from './document';
import { prose } from './prose';
import { zh } from '../strings';

const modeSync = Annotation.define<boolean>();
const setFrontmatter = StateEffect.define<string | null>();
const frontmatterField = StateField.define<string | null>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setFrontmatter)) {
				value = effect.value;
			}
		}
		return value;
	},
});
const frontmatterHistory = [
	invertedEffects.of((tr) => {
		if (tr.annotation(Transaction.addToHistory) === false) {
			return [];
		}
		const previous = tr.startState.field(frontmatterField);
		if (previous === null) {
			return [];
		}
		return tr.effects.filter((effect) => effect.is(setFrontmatter) && effect.value !== null).map(() => setFrontmatter.of(previous));
	}),
	EditorState.transactionFilter.of((tr) => {
		if (tr.annotation(Transaction.addToHistory) === false || tr.startState.field(frontmatterField) !== null) {
			return tr;
		}
		for (const effect of tr.effects) {
			if (effect.is(setFrontmatter) && effect.value !== null) {
				const current = tr.startState.doc.toString();
				const head = frontmatterLength(current) || (current.startsWith('\uFEFF') ? 1 : 0);
				return [tr, { changes: { from: 0, to: head, insert: effect.value }, effects: setFrontmatter.of(null) }];
			}
		}
		return tr;
	}),
];

function fullText(state: EditorState): string {
	return (state.field(frontmatterField) ?? '') + state.doc.toString();
}

function prefixLength(state: EditorState): number {
	return (state.field(frontmatterField) ?? '').length;
}

export interface EditorHandle {
	view: EditorView;
	ghost: GhostController;
	reload(): void;
	find(): void;
	goTo(offset: number): void;
	flush(): void;
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
	const formHandle = useRef<LoreFormHandle | undefined>(undefined);
	const editedInSource = useRef(false);
	const stateForRef = useRef<((anchor: number, head: number, form: LoreFormData | undefined) => EditorState) | undefined>(undefined);
	const parent = useRef<HTMLDivElement>(null);
	const handle = useRef<EditorHandle | undefined>(undefined);
	const callbacks = useRef({ ready, cursor });
	callbacks.current = { ready, cursor };
	useEffect(() => {
		const ghost = new GhostController(
			model.path,
			chapter,
			window.novel,
			settings.debounceMs,
			nextRequestId,
			{
				start: () => model.compositionStart(),
				end: (text) => model.compositionEnd(text),
			},
			(state) => state.field(frontmatterField) ?? '',
		);
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
				const syncOnly = update.transactions.some((tr) => tr.annotation(modeSync));
				const prefixChanged = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setFrontmatter)));
				if (!syncOnly && (update.docChanged || prefixChanged)) {
					if (update.docChanged && update.state.field(frontmatterField) === null) {
						editedInSource.current = true;
						if (loreRef.current && !sourceModeRef.current) {
							setSourceMode(true);
						}
					}
					model.edit(fullText(update.state));
				}
				if (!syncOnly && (update.selectionSet || update.docChanged || prefixChanged)) {
					const selection = update.state.selection.main;
					const offset = prefixLength(update.state);
					callbacks.current.cursor(offset + selection.anchor, offset + selection.head);
				}
			}),
		];
		const stateFor = (anchor: number, head: number, form: LoreFormData | undefined) => {
			const doc = form ? form.body : model.text;
			const base = form ? form.prefix.length : 0;
			const clamp = (pos: number) => Math.max(0, Math.min(pos - base, doc.length));
			return EditorState.create({
				doc,
				selection: { anchor: clamp(anchor), head: clamp(head) },
				extensions: [
					frontmatterField.init(() => (form ? form.prefix : null)),
					...frontmatterHistory,
					model.readOnly ? [] : loreExtension(entriesRef.current, (path, options) => callbacksOpen.current(path, options)),
					...extensions,
				],
			});
		};
		stateForRef.current = stateFor;
		const initialForm = loreRef.current && !sourceModeRef.current ? formDataRef.current : undefined;
		const view = new EditorView({ parent: parent.current!, state: stateFor(tab.anchor, tab.head, initialForm) });
		ghost.attach(view);
		const instance: EditorHandle = {
			view,
			ghost,
			find: () => {
				openSearchPanel(view);
			},
			goTo: (offset) => {
				const target = Math.max(0, Math.min(offset - prefixLength(view.state), view.state.doc.length));
				view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
			},
			flush: () => {
				formHandle.current?.flush();
			},
			reload: () => {},
		};
		// Reload changes are excluded from history; a fresh history starts with the disk version.
		instance.reload = () => {
			ghost.send({ type: 'blur' });
			editedInSource.current = false;
			const offset = prefixLength(view.state);
			const selection = view.state.selection.main;
			const nextForm = loreRef.current && !sourceModeRef.current ? inspectLoreForm(model.text) : undefined;
			view.setState(stateFor(offset + selection.anchor, offset + selection.head, nextForm));
			ghost.attach(view);
			const nextOffset = prefixLength(view.state);
			callbacks.current.cursor(nextOffset + view.state.selection.main.anchor, nextOffset + view.state.selection.main.head);
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
		const ghost = handle.current?.ghost;
		if (!view || !ghost) {
			return;
		}
		const currentPrefix = view.state.field(frontmatterField);
		if (formActive && currentPrefix === null) {
			const form = formDataRef.current!;
			const selection = view.state.selection.main;
			if (editedInSource.current) {
				editedInSource.current = false;
				view.setState(stateForRef.current!(selection.anchor, selection.head, form));
				ghost.attach(view);
			} else {
				const anchor = Math.max(0, Math.min(selection.anchor - form.prefix.length, form.body.length));
				const head = Math.max(0, Math.min(selection.head - form.prefix.length, form.body.length));
				view.dispatch({
					changes: { from: 0, to: form.prefix.length, insert: '' },
					selection: { anchor, head },
					effects: setFrontmatter.of(form.prefix),
					annotations: [modeSync.of(true), Transaction.addToHistory.of(false)],
				});
			}
		} else if (!formActive && currentPrefix !== null) {
			formHandle.current?.flush();
			const prefix = view.state.field(frontmatterField);
			if (prefix !== null) {
				const selection = view.state.selection.main;
				view.dispatch({
					changes: { from: 0, to: 0, insert: prefix },
					selection: { anchor: selection.anchor + prefix.length, head: selection.head + prefix.length },
					effects: setFrontmatter.of(null),
					annotations: [modeSync.of(true), Transaction.addToHistory.of(false)],
				});
			}
		}
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
			formHandle.current?.flush();
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
	const commit = (key: string, raw: string | boolean) => {
		const view = handle.current?.view;
		const current = formDataRef.current;
		if (!view || !current) {
			return;
		}
		const nextText = commitLoreField(model.text, current, key, raw);
		if (nextText === undefined) {
			return;
		}
		const nextForm = inspectLoreForm(nextText);
		if (!nextForm) {
			return;
		}
		view.dispatch({
			effects: setFrontmatter.of(nextForm.prefix),
			annotations: isolateHistory.of('full'),
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
					commit={commit}
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
						formHandle.current?.flush();
						setSourceMode(true);
						queueMicrotask(() => handle.current?.view.focus());
					}}
					handleRef={formHandle}
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
