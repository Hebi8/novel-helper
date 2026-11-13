import type { AssistantDiff } from '../../shared/assistant';

export type DiffView = AssistantDiff & { beforeLabel?: string; afterLabel?: string };
export const assistantEvents = {
	focus: 'novel:assistant:focus',
	stop: 'novel:assistant:stop',
	history: 'novel:assistant:history',
	diff: 'novel:assistant:diff',
} as const;

export function showConflictDiff(diff: DiffView): void {
	window.dispatchEvent(new CustomEvent(assistantEvents.diff, { detail: diff }));
}
