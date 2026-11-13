import type { Change } from '../../core/snapshot';

export interface AssistantFilesChanged {
	root: string;
	changes: Change[];
}
function event() {
	const listeners = new Set<(event: AssistantFilesChanged) => void>();
	return {
		listen(listener: (event: AssistantFilesChanged) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(event: AssistantFilesChanged): void {
			listeners.forEach((listener) => listener(event));
		},
	};
}
const turns = event();
const reverts = event();
export const onAssistantTurnEnded = turns.listen;
export const onAssistantReverted = reverts.listen;
export const assistantTurnEnded = turns.emit;
export const assistantReverted = reverts.emit;
