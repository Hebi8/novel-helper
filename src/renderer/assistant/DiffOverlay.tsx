import { useEffect, useRef, type ReactNode } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { zh } from '../strings';
import { Overlay } from './Overlay';
import type { DiffView } from './events';

export function DiffOverlay({
	diff,
	close,
	open,
	actions,
}: {
	diff: DiffView;
	close(): void;
	open(path: string): void;
	actions?: ReactNode;
}) {
	const parent = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const extensions = [
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			EditorView.lineWrapping,
			lineNumbers(),
			markdown(),
			EditorView.theme({
				'&': { height: '100%', backgroundColor: 'var(--paper)', color: 'var(--ink)' },
				'.cm-scroller': { overflow: 'auto' },
				'.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--soft)', borderColor: 'var(--line)' },
			}),
		];
		const view = new MergeView({
			parent: parent.current!,
			a: { doc: diff.before, extensions },
			b: { doc: diff.after, extensions },
			highlightChanges: true,
			gutter: true,
		});
		return () => view.destroy();
	}, [diff]);
	return (
		<Overlay title={`${zh.assistantDiff} · ${diff.path}`} close={close} wide>
			<div className="assistant-diff-labels">
				<span>{diff.beforeLabel ?? zh.assistantBefore}</span>
				<span>{diff.afterLabel ?? zh.assistantAfter}</span>
			</div>
			<div className="assistant-merge" ref={parent} />
			{actions ??
				(diff.canOpen ? (
					<footer>
						<button onClick={() => open(diff.path)}>{zh.assistantOpenFile}</button>
					</footer>
				) : null)}
		</Overlay>
	);
}
