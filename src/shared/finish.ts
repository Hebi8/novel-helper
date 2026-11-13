import type { NamesLanguage } from '../core/story';
import type { ScaffoldItem } from '../core/scaffold';
import type { Rename } from '../core/library';
import type { OpenResult } from './api';
export type StructureAction = 'chapter' | 'level' | 'rename';
export interface StructureInput {
	action: StructureAction;
	path?: string;
	name: string;
	chapter?: string;
}
export interface StructureSuggestion {
	name: string;
	chapter: string;
}
export interface SearchMatch {
	line: number;
	column: number;
	offset: number;
	length: number;
	text: string;
}
export interface SearchResult {
	total: number;
	groups: { path: string; matches: SearchMatch[] }[];
}
export interface FinishAPI {
	plan(root: string, language: NamesLanguage): Promise<ScaffoldItem[]>;
	initialize(root: string, language: NamesLanguage, selected: string[]): Promise<OpenResult>;
	suggest(action: StructureAction, path?: string): Promise<StructureSuggestion>;
	create(input: StructureInput): Promise<{ path?: string; renames?: Rename[] }>;
	reveal(path: string): Promise<void>;
	search(query: string): Promise<SearchResult>;
	focus(enabled: boolean): Promise<void>;
}
