import { createContext, useContext } from 'react';
import type { Book, SessionState, OpenOptions, ReferenceData, BuoyStatus, ReportKind } from '../shared/api';
export interface EditorSnapshot {
	path: string;
	text: string;
	anchor: number;
	head: number;
}
/** Panels share the writing workspace without owning or duplicating its editor. */
export interface Workspace {
	structure(action: import('../shared/structure').StructureAction, path?: string): void;
	searchBook(): void;
	book?: Book;
	session: SessionState;
	current(): EditorSnapshot | undefined;
	open(path: string, options?: OpenOptions): Promise<void>;
	openConflict(path: string): void;
	reference: ReferenceData;
	buoy?: BuoyStatus;
	chapter?: string;
	split(): void;
	focusEditor(): void;
	find(): void;
	quickOpen(): void;
	report(kind: ReportKind): Promise<void>;
	showOutline(): void;
	saveAll(): Promise<boolean>;
	fail(message: string): void;
}
export const WorkspaceContext = createContext<Workspace | undefined>(undefined);
export function useWorkspace(): Workspace {
	return useContext(WorkspaceContext)!;
}
