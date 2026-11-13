import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorContext } from '../../core/assistantBrief';
import type { EditorSnapshot, Workspace } from '../workspace';
import { assistantContext } from './context';

/** Cursor movement updates workspace refs without rendering the side panels. */
export function useEditorContext(workspace: Workspace) {
	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;
	const previous = useRef<EditorSnapshot | undefined>(undefined);
	const [context, setContext] = useState<EditorContext>();
	const refresh = useCallback(() => {
		const next = workspaceRef.current.current();
		const last = previous.current;
		if (next?.path === last?.path && next?.text === last?.text && next?.anchor === last?.anchor && next?.head === last?.head) {
			return;
		}
		previous.current = next;
		setContext(assistantContext(next));
	}, []);
	useEffect(refresh, [refresh, workspace.session.active]);
	useEffect(() => {
		const timer = setInterval(refresh, 150);
		return () => clearInterval(timer);
	}, [refresh]);
	return { context, refresh };
}
