import { existsSync,readFileSync,mkdirSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { defaults,type Settings,type SettingKey } from '../../shared/defaults';
import { PROVIDERS,REQUEST_TIMEOUT_MS,maxOutputTokens,type ProviderId } from '../../llm/providers';
import type { ContextLimits } from '../../core/context';
import type { Rates } from '../../core/usage';
export class SettingsStore {
  private readonly file: string;
  private value: Settings;
  constructor(directory: string) {
    mkdirSync(directory,{ recursive: true });
    this.file=join(directory,'settings.json');
    this.value={ ...structuredClone(defaults),...(existsSync(this.file)? JSON.parse(readFileSync(this.file,'utf8')):{}) };
  }
  get(): Settings { return structuredClone(this.value); }
  set<K extends SettingKey>(key: K,value: Settings[K]): void {
    this.value[key]=value;
    writeFileSync(this.file+'.tmp',JSON.stringify(this.value,null,2));
    renameSync(this.file+'.tmp',this.file);
  }
  model() {
    const c=this.value;
    const provider=c.provider as ProviderId;
    const preset=PROVIDERS[provider];
    return {
      provider,protocol: preset.protocol,baseUrl: provider==='openaiCompatible'? c['openaiCompatible.baseUrl']:preset.baseUrl,
      model: c[`${provider}.model`]||preset.defaultModel,maxTokens: maxOutputTokens(c.maxSuggestionChars),maxTokensField: preset.maxTokensField,
      extraBody: { ...preset.extraBody,...c.extraRequestBody },cacheBreakpoints: preset.cacheBreakpoints,
      timeoutMs: REQUEST_TIMEOUT_MS,usageWaitMs: preset.usageWaitMs,keyRequired: preset.keyRequired,pricing: preset.pricing
    };
  }
  limits(): ContextLimits&{ previousChapters: number; } {
    return Object.fromEntries(Object.entries(this.value).filter(([key]) => key.startsWith('context.')).map(([key,value]) => [key.slice(8),value])) as unknown as ContextLimits&{ previousChapters: number; };
  }
  prices(): Record<string,Rates> { return this.value['usage.prices']; }
}
