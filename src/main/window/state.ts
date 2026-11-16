import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionState } from '../../shared/api';
interface WindowState {
	recent: string[];
	open: string[];
	active?: string;
	books: Record<string, SessionState>;
}
export class WindowStore {
	readonly value: WindowState;
	private readonly file: string;
	constructor(directory: string) {
		this.file = join(directory, 'windows.json');
		this.value = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { recent: [], open: [], books: {} };
	}
	save(): void {
		writeFileSync(this.file + '.tmp', JSON.stringify(this.value));
		renameSync(this.file + '.tmp', this.file);
	}
	forget(root: string): void {
		this.value.recent = this.value.recent.filter((path) => path !== root);
		this.value.open = this.value.open.filter((path) => path !== root);
		if (this.value.active === root) {
			this.value.active = undefined;
		}
		delete this.value.books[root];
		this.save();
	}
	opened(root: string, activate = true): void {
		this.value.recent = [root, ...this.value.recent.filter((p) => p !== root)].slice(0, 10);
		this.value.open = [...new Set([...this.value.open, root])];
		if (activate) {
			this.value.active = root;
		}
		this.save();
	}
	setActive(root: string | undefined): void {
		this.value.active = root;
		this.save();
	}
	replaceOpen(oldRoot: string, newRoot: string): void {
		const next = this.value.open.map((path) => (path === oldRoot ? newRoot : path));
		this.value.open = [...new Set(next)];
		if (this.value.active === oldRoot) {
			this.value.active = newRoot;
		}
		this.save();
	}
	closed(root: string, nextActive?: string): void {
		this.value.open = this.value.open.filter((path) => path !== root);
		this.value.active = nextActive;
		this.save();
	}
	replaceRecent(oldRoot: string, newRoot: string): void {
		const replaced = this.value.recent.map((path) => (path === oldRoot ? newRoot : path));
		this.value.recent = [newRoot, ...replaced.filter((path) => path !== newRoot)].slice(0, 10);
		this.save();
	}
	session(root: string): SessionState {
		return this.value.books[root] ?? { tabs: [] };
	}
	setSession(root: string, session: SessionState): void {
		this.value.books[root] = session;
		this.save();
	}
}
