import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { SettingsStore } from './settings/store';
import type { SecretStore } from './secrets/store';
import type { CompletionService } from './completion/service';
import type { BookIndex } from './book/indexer';
import type { WindowStore } from './window/state';
import type { OpenResult } from '../shared/api';
export interface MainContext {
	reindexBooks(): Promise<void>;
	prepareBookRename(root: string): Promise<void>;
	settings: SettingsStore;
	secrets: SecretStore;
	completion: CompletionService;
	windows: WindowStore;
	bookFor(event: IpcMainInvokeEvent): BookIndex | undefined;
	onBookClosed(cleanup: (root: string) => void | Promise<void>): void;
	windowFor(event: Pick<IpcMainInvokeEvent, 'sender'>): BrowserWindow;
	broadcast(channel: string, data: unknown): void;
	open(root: string, source?: BrowserWindow, selected?: boolean): Promise<OpenResult>;
	openSettings(): void;
	openWelcome(result: OpenResult): void;
	initialResult(event: IpcMainInvokeEvent): OpenResult | undefined;
}
