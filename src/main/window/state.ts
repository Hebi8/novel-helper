import { existsSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionState } from '../../shared/api';
interface WindowState { recent: string[]; open: string[]; books: Record<string,SessionState>; }
export class WindowStore {
  readonly value: WindowState;
  private readonly file: string;
  constructor(directory: string) {
    this.file=join(directory,'windows.json');
    this.value=existsSync(this.file)? JSON.parse(readFileSync(this.file,'utf8')):{ recent: [],open: [],books: {} };
  }
  save(): void { writeFileSync(this.file+'.tmp',JSON.stringify(this.value)); renameSync(this.file+'.tmp',this.file); }
  opened(root: string): void {
    this.value.recent=[root,...this.value.recent.filter(p => p!==root)].slice(0,10);
    this.value.open=[...new Set([...this.value.open,root])]; this.save();
  }
  session(root: string): SessionState { return this.value.books[root]??{ tabs: [] }; }
  setSession(root: string,session: SessionState): void { this.value.books[root]=session; this.save(); }
}
