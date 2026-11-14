import type { EditorContext } from '../core/assistantBrief';
import type { Item } from '../core/transcript';
import type { SnapshotRecord } from '../core/snapshot';
import type { Blocked } from '../storage/snapshotStore';

export type AssistantOptionCategory = 'model' | 'thought_level';
export interface AssistantOptionValue {
	value: string;
	name: string;
	description?: string;
}
export interface AssistantOption {
	id: string;
	name: string;
	category: AssistantOptionCategory;
	value: string;
	values: AssistantOptionValue[];
}
export interface AssistantState {
	items: Item[];
	busy: boolean;
	status: string;
	options: AssistantOption[];
	probing?: boolean;
}
export type AssistantEvent =
	| { type: 'state'; state: AssistantState }
	| { type: 'status'; busy: boolean; status: string }
	| { type: 'options'; options: AssistantOption[] }
	| { type: 'probing'; probing: boolean }
	| { type: 'item'; index: number; item: Item };
export interface AssistantDiff {
	path: string;
	before: string;
	after: string;
	canOpen: boolean;
	timed?: boolean;
}
export interface AssistantAPI {
	state(): Promise<AssistantState>;
	probe(): Promise<boolean>;
	send(text: string, context?: Partial<EditorContext>): Promise<boolean>;
	setOption(id: string, value: string): Promise<boolean>;
	stop(): Promise<void>;
	newSession(): Promise<void>;
	answer(id: string, allow: boolean): Promise<void>;
	history(): Promise<SnapshotRecord[]>;
	diff(record: number, path: string): Promise<AssistantDiff>;
	revert(record: number): Promise<{ blocked: Blocked[] }>;
	openLink(href: string): Promise<void>;
	onChanged(listener: (event: AssistantEvent) => void): () => void;
}
