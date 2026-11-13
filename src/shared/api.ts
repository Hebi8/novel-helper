import type { BookNode } from '../core/library';
import type { Totals } from '../core/usage';
import type { ProviderId } from '../llm/providers';
import type { Settings, SettingKey } from './defaults';
import type { AssistantAPI } from './assistant';
export type { Settings, SettingKey };
export interface Book {
	referenceVersion?: number;
	buoyVersion?: number;
	root: string;
	name: string;
	tree: BookNode;
}
export interface TabState {
	path: string;
	anchor: number;
	head: number;
}
export interface SessionState {
	tabs: TabState[];
	active?: string;
}
export interface DiskFile {
	error?: string;
	path: string;
	text: string;
}
export type SaveResult = { saved: true } | { saved: false; disk: string };
export interface CompletionInput {
	id: number;
	path: string;
	text: string;
	offset: number;
	manual: boolean;
}
export type CompletionResult = { status: 'ok'; text: string } | { status: 'skipped' | 'cancelled' | 'error'; error?: string };
export interface UsageStatus {
	state: 'off' | 'on' | 'requesting' | 'problem' | 'limit';
	missingKey: boolean;
	priced: boolean;
	problem?: string;
	today: Totals;
}
export type OpenResult =
	| { kind: 'error'; message: string }
	| { kind: 'opened' }
	| { kind: 'choices'; roots: string[] }
	| { kind: 'empty'; root?: string }
	| { kind: 'cancelled' };
export type MenuCommand =
	| 'newChapter'
	| 'searchBook'
	| 'focus'
	| 'assistant:focus'
	| 'assistant:stop'
	| 'assistant:history'
	| 'closeTab'
	| 'previousTab'
	| 'nextTab'
	| 'find'
	| 'manual'
	| 'left:toggle'
	| 'right:toggle'
	| 'left:0'
	| 'left:1'
	| 'left:2'
	| 'right:0'
	| 'right:1'
	| 'right:2'
	| 'split'
	| 'quickOpen'
	| 'report'
	| 'usageReport'
	| 'flush';
export interface Bootstrap {
	openResult?: OpenResult;
	book?: Book;
	recent: string[];
	session: SessionState;
	settings: Settings;
	usage: UsageStatus;
}
export interface AppAPI {
	finish: import('./finish').FinishAPI;
	assistant: AssistantAPI;
	book: {
		open(root?: string): Promise<OpenResult>;
		read(path: string): Promise<DiskFile>;
		save(path: string, text: string, base: string, force?: boolean): Promise<SaveResult>;
		onOpenResult(listener: (result: OpenResult) => void): () => void;
		onChanged(listener: (book: Book) => void): () => void;
		onFileChanged(listener: (file: DiskFile) => void): () => void;
	};
	completion: {
		request(input: CompletionInput): Promise<CompletionResult>;
		cancel(id: number): void;
	};
	settings: {
		get(): Promise<Settings>;
		set<K extends SettingKey>(key: K, value: Settings[K]): Promise<void>;
		open(): Promise<void>;
		onChanged(listener: (settings: Settings) => void): () => void;
	};
	secrets: {
		has(provider: ProviderId): Promise<boolean>;
		set(provider: ProviderId, key: string): Promise<void>;
		clear(provider: ProviderId): Promise<void>;
	};
	usage: { onChanged(listener: (status: UsageStatus) => void): () => void };
	window: {
		bootstrap(): Promise<Bootstrap>;
		saveSession(session: SessionState): Promise<void>;
		flushed(): void;
		close(): void;
		onCommand(listener: (command: MenuCommand) => void): () => void;
	};
}
export const channels = {
	assistantState: 'assistant:state',
	assistantSend: 'assistant:send',
	assistantStop: 'assistant:stop',
	assistantNewSession: 'assistant:newSession',
	assistantAnswer: 'assistant:answer',
	assistantHistory: 'assistant:history',
	assistantDiff: 'assistant:diff',
	assistantRevert: 'assistant:revert',
	assistantLink: 'assistant:link',
	assistantChanged: 'assistant:changed',
	referenceGet: 'reference:get',
	loreSet: 'reference:set',
	loreCreate: 'reference:create',
	companionOpen: 'reference:companion',
	quickOpen: 'reference:quickOpen',
	buoyGet: 'buoy:get',
	buoyAction: 'buoy:action',
	buoyChanged: 'buoy:changed',
	reportGet: 'report:get',
	reportChanged: 'report:changed',
	bookOpen: 'book:open',
	openResult: 'book:openResult',
	bookRead: 'book:read',
	bookSave: 'book:save',
	bookChanged: 'book:changed',
	fileChanged: 'book:fileChanged',
	completionRequest: 'completion:request',
	completionCancel: 'completion:cancel',
	settingsGet: 'settings:get',
	settingsSet: 'settings:set',
	settingsOpen: 'settings:open',
	settingsChanged: 'settings:changed',
	secretsHas: 'secrets:has',
	secretsSet: 'secrets:set',
	secretsClear: 'secrets:clear',
	usageChanged: 'usage:changed',
	bootstrap: 'window:bootstrap',
	session: 'window:session',
	command: 'window:command',
	flushed: 'window:flushed',
	close: 'window:close',
} as const;

export interface OutlineItem {
	id: string;
	title: string;
	kind: 'book' | 'folder' | 'file' | 'heading';
	file?: string;
	line: number;
	text: string;
	children: string[];
	links: { raw: string; target?: string; problem?: 'missing' | 'ambiguous' }[];
	next?: string;
}
export interface ReferenceData {
	entries: import('../core/library').LoreEntry[];
	outlines: string[];
	nodes: OutlineItem[];
}
export interface BuoyStatus {
	unreadable?: string[];
	chapter: string;
	state?: import('../core/buoy').BuoyState;
	lost: boolean;
}
export type BuoyAction = 'in' | 'bridge' | 'parallel' | 'dropSecond' | 'forward' | 'back' | 'relocate';
export type ReportKind = 'report' | 'usageReport';
export interface QuickItem {
	id: string;
	path: string;
	title: string;
	aliases: string[];
	kind: 'chapter' | 'lore' | 'outline' | 'file';
	line?: number;
}
export interface OpenOptions {
	offset?: number;
	line?: number;
	beside?: boolean;
}
export interface AppAPI {
	reference: {
		get(): Promise<ReferenceData>;
		set(path: string, field: 'always' | 'aliases' | 'type', value: import('../core/frontmatter').FieldValue): Promise<void>;
		create(name: string, type: string): Promise<string>;
		companion(path: string, kind: 'outline' | 'summary'): Promise<string>;
		quick(): Promise<QuickItem[]>;
	};
	buoys: {
		get(chapter: string, text?: string): Promise<BuoyStatus>;
		act(chapter: string, action: BuoyAction, node?: string): Promise<void>;
		onChanged(listener: (root: string) => void): () => void;
	};
	reports: {
		get(kind: ReportKind): Promise<string>;
		onChanged(listener: () => void): () => void;
	};
}
