import { createContext, useContext } from 'react';
import type { Book, SessionState } from '../shared/api';
export interface EditorSnapshot {
  path: string;
  text: string;
  anchor: number;
  head: number;
}
/** Panels share the writing workspace without owning or duplicating its editor. */
export interface Workspace {
  book?: Book;
  session: SessionState;
  current?: EditorSnapshot;
  open(path: string): Promise<void>;
  saveAll(): Promise<boolean>;
}
export const WorkspaceContext = createContext<Workspace | undefined>(undefined);
export function useWorkspace(): Workspace { return useContext(WorkspaceContext)!; }
