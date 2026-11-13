import type { EditorContext } from '../../core/assistantBrief';
import type { EditorSnapshot } from '../workspace';

export function assistantContext(snapshot?: EditorSnapshot): EditorContext | undefined {
	if (!snapshot) {
		return;
	}
	const position = (offset: number) => {
		const before = snapshot.text.slice(0, offset);
		return { line: before.split('\n').length, column: before.slice(before.lastIndexOf('\n') + 1).length + 1 };
	};
	const start = Math.min(snapshot.anchor, snapshot.head);
	const end = Math.max(snapshot.anchor, snapshot.head);
	const from = position(start);
	const to = position(end);
	return {
		path: snapshot.path,
		line: position(snapshot.head).line,
		...(start !== end && {
			selection: {
				text: snapshot.text.slice(start, end),
				startLine: from.line,
				startColumn: from.column,
				endLine: to.line,
				endColumn: to.column,
			},
		}),
	};
}
