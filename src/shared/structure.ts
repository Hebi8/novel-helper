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
export interface RenameResult {
	renames: Rename[];
	error?: string;
}
export type TrashTarget = { kind: 'structure' | 'lore'; path: string };
export interface TrashPreview {
	kind: 'chapter' | 'level' | 'lore';
	name: string;
	path: string;
	targets: string[];
	scope: string[];
	sublevels: number;
	sublevelUnit: string;
	chapters: number;
	words: number;
	outlines: number;
	summaries: number;
	hasBuoys: boolean;
}
export interface TrashResult {
	trashed: string[];
	error?: string;
}
export interface StructureAPI {
	plan(root: string, language: NamesLanguage): Promise<ScaffoldItem[]>;
	initialize(root: string, language: NamesLanguage, selected: string[]): Promise<OpenResult>;
	suggest(action: StructureAction, path?: string): Promise<StructureSuggestion>;
	create(input: StructureInput): Promise<{ path?: string; renames?: Rename[]; error?: string }>;
	trashPlan(target: TrashTarget): Promise<TrashPreview>;
	trash(plan: TrashPreview): Promise<TrashResult>;
}
