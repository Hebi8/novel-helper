import type { BrowserWindow,IpcMainInvokeEvent } from 'electron';
import type { SettingsStore } from './settings/store';
import type { SecretStore } from './secrets/store';
import type { CompletionService } from './completion/service';
import type { BookIndex } from './book/indexer';
import type { WindowStore } from './window/state';
import type { OpenResult } from '../shared/api';
export interface MainContext {
  settings: SettingsStore; secrets: SecretStore; completion: CompletionService; windows: WindowStore;
  bookFor(event: IpcMainInvokeEvent): BookIndex;
  windowFor(event: IpcMainInvokeEvent): BrowserWindow;
  broadcast(channel: string,data: unknown): void;
  open(root: string,source?: BrowserWindow): Promise<OpenResult>;
  openSettings(): void;
}
