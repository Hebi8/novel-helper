import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
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
	chapter: boolean;
	settings: Settings;
	limited: boolean;
	nextRequestId(): number;
	ready(handle?: EditorHandle): void;
	cursor(anchor: number, head: number): void;
}
export function Editor({ document: model, tab, active, chapter, settings, limited, ready, cursor, nextRequestId }: Props) {
	const parent = useRef<HTMLDivElement>(null);
	const handle = useRef<EditorHandle | undefined>(undefined);
	const callbacks = useRef({ ready, cursor });
	callbacks.current = { ready, cursor };
	useEffect(() => {
		const ghost = new GhostController(model.path, chapter, window.novel, settings.debounceMs, nextRequestId);
		const extensions = [
			history(),
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
				extensions,
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
		handle.current?.ghost.settings(settings.enabled, settings.trigger === 'auto', limited, settings.debounceMs, JSON.stringify(settings));
	}, [settings, limited]);
	useEffect(() => {
		if (active) {
			handle.current?.view.requestMeasure();
			handle.current?.view.focus();
		} else {
			handle.current?.ghost.send({ type: 'blur' });
			void model.save();
		}
	}, [active, model]);
	return <div className="editor" ref={parent} style={{ display: active ? undefined : 'none' }} />;
}
