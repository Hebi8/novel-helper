import { ipcMain } from 'electron';
import { channels } from '../../shared/api';
import type { ProviderId } from '../../llm/providers';
import type { MainContext } from '../context';
export function registerSecrets(ctx: MainContext): void {
  ipcMain.handle(channels.secretsHas,(_event,provider: ProviderId) => ctx.secrets.has(provider));
  ipcMain.handle(channels.secretsSet,(_event,provider: ProviderId,key: string) => { ctx.secrets.set(provider,key); ctx.completion.settingsChanged(); });
  ipcMain.handle(channels.secretsClear,(_event,provider: ProviderId) => { ctx.secrets.set(provider); ctx.completion.settingsChanged(); });
}
