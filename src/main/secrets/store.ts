import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '../../llm/providers';
export class SecretStore {
	private readonly file: string;
	constructor(directory: string) {
		this.file = join(directory, 'secrets.json');
	}
	private encrypted(): Partial<Record<ProviderId, string>> {
		return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
	}
	has(provider: ProviderId): boolean {
		return !!this.encrypted()[provider];
	}
	get(provider: ProviderId): string | undefined {
		const value = this.encrypted()[provider];
		return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : undefined;
	}
	set(provider: ProviderId, value?: string): void {
		const values = this.encrypted();
		if (value) {
			values[provider] = safeStorage.encryptString(value).toString('base64');
		} else {
			delete values[provider];
		}
		writeFileSync(this.file + '.tmp', JSON.stringify(values));
		renameSync(this.file + '.tmp', this.file);
	}
}
