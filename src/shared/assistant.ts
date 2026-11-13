import type { EditorContext } from '../core/assistantBrief';
import type { Item } from '../core/transcript';
import type { SnapshotRecord } from '../core/snapshot';
import type { Blocked } from '../storage/snapshotStore';

export interface AssistantState {
	items: Item[];
	busy: boolean;
	status: string;
}
export interface AssistantDiff {
	path: string;
	before: string;
	after: string;
	canOpen: boolean;
}
export interface AssistantAPI {
	state(): Promise<AssistantState>;
	send(text: string, context?: Partial<EditorContext>): Promise<boolean>;
	stop(): Promise<void>;
	newSession(): Promise<void>;
	answer(id: string, allow: boolean): Promise<void>;
	history(): Promise<SnapshotRecord[]>;
	diff(record: number, path: string): Promise<AssistantDiff>;
	revert(record: number): Promise<{ blocked: Blocked[] }>;
	openLink(href: string): Promise<void>;
	onChanged(listener: (state: AssistantState) => void): () => void;
}
