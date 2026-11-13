import { loreExtension } from '../reference/loreExtension';
import { useWorkspace } from '../workspace';
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { GhostController } from '../ghost/extension';
import type { Settings, TabState } from '../../shared/api';
import type { DocumentModel } from './document';
import { prose } from './prose';
import { zh } from '../strings';
export interface EditorHandle {
	view: EditorView;
	ghost: GhostController;
	reload(): void;
	find(): void;
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
	const workspace = useWorkspace();
	const lore = useRef(new Compartment());
	const callbacksOpen = useRef(workspace.open);
	const entriesRef = useRef(workspace.reference.entries);
	entriesRef.current = workspace.reference.entries;
	callbacksOpen.current = workspace.open;
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
			markdown(),
			EditorView.lineWrapping,
			EditorState.phrases.of(zh.search),
			search({ top: true }),
			keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
			EditorView.contentAttributes.of({ 'aria-label': model.path, spellcheck: 'false' }),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					model.edit(update.state.doc.toString());
				}
				if (update.selectionSet || update.docChanged) {
					const selection = update.state.selection.main;
					callbacks.current.cursor(selection.anchor, selection.head);
				}
			}),
		];
		const stateFor = (anchor: number, head: number) =>
			EditorState.create({
				doc: model.text,
				selection: { anchor: Math.min(anchor, model.text.length), head: Math.min(head, model.text.length) },
				extensions: [
					lore.current.of(model.readOnly ? [] : loreExtension(entriesRef.current, (path, options) => callbacksOpen.current(path, options))),
					...extensions,
				],
			});
		const view = new EditorView({ parent: parent.current!, state: stateFor(tab.anchor, tab.head) });
		ghost.attach(view);
		const instance: EditorHandle = {
			view,
			ghost,
			find: () => {
				openSearchPanel(view);
			},
			reload: () => {},
		};
		// Reload changes are excluded from history; a fresh history starts with the disk version.
		instance.reload = () => {
			ghost.send({ type: 'blur' });
			const selection = view.state.selection.main;
			view.setState(stateFor(selection.anchor, selection.head));
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
			handle.current?.view.focus();
			if (handle.current) {
				handle.current.view.dispatch({ effects: EditorView.scrollIntoView(handle.current.view.state.selection.main.head) });
			}
		} else {
			handle.current?.ghost.send({ type: 'blur' });
			void model.save();
		}
	}, [active, model]);
	useEffect(() => {
		handle.current?.view.dispatch({
			effects: lore.current.reconfigure(
				model.readOnly
					? []
					: loreExtension(workspace.reference.entries, (path, options) => {
							return callbacksOpen.current(path, options);
						}),
			),
		});
	}, [workspace.reference.entries, model]);
	useEffect(() => {
		if (visible) {
			handle.current?.view.requestMeasure();
		}
	}, [visible]);
	return <div className={`editor pane-${side}`} ref={parent} onFocus={focused} style={{ display: visible ? undefined : 'none' }} />;
}
