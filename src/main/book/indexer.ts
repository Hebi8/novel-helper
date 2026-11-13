import { readdir,realpath } from 'node:fs/promises';
import { watch,type FSWatcher } from 'node:fs';
import { join,basename,matchesGlob } from 'node:path';
import { Library,globRootDepth,type FileKind } from '../../core/library';
import { MARKER_FILE,SCAN_DEPTH,SCAN_EXCLUDE,parseMarker,storyState,storiesFromMarkers,isUsable } from '../../core/story';
import { defaults } from '../../shared/defaults';
import type { Book,DiskFile,SaveResult } from '../../shared/api';
import { atomicWrite,readOptional } from './files';
const groups=[['lore',defaults['files.lore']],['chapter',defaults['files.chapters']],['outline',defaults['files.outlines']],['summary',defaults['files.summaries']]] as const;
export async function scanFiles(root: string,relative=''): Promise<string[]> {
  const entries=await readdir(join(root,relative),{ withFileTypes: true });
  return (await Promise.all(entries.filter(e => !e.name.startsWith('.')&&!['node_modules','dist','out'].includes(e.name)).map(async e => {
    const path=relative? `${relative}/${e.name}`:e.name;
    return e.isDirectory()? scanFiles(root,path):e.isFile()&&/\.(md|txt)$/.test(e.name)? [path]:[];
  }))).flat();
}
export async function findStories(root: string): Promise<string[]> {
  const markers: string[]=[];
  async function visit(relative: string,depth: number): Promise<void> {
    const marker=relative? `${relative}/${MARKER_FILE}`:MARKER_FILE;
    const text=await readOptional(join(root,marker));
    if(text!==undefined&&parseMarker(text)) { markers.push(marker); }
    if(depth===SCAN_DEPTH) { return; }
    const entries=await readdir(join(root,relative),{ withFileTypes: true });
    await Promise.all(entries.filter(e => e.isDirectory()&&!e.name.startsWith('.')&&!matchesGlob(`${relative}/${e.name}/file`,SCAN_EXCLUDE)).map(e => visit(relative? `${relative}/${e.name}`:e.name,depth+1)));
  }
  await visit('',0);
  return storiesFromMarkers(markers).slice(0,50).map(p => join(root,p));
}
export class BookIndex {
  library=new Library(defaults['files.bookNames']);
  private contents=new Map<string,string>();
  private watcher?: FSWatcher;
  private queue: Promise<void>=Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed=false;
  onChanged: (book: Book) => void=() => { };
  onFileChanged: (file: DiskFile) => void=() => { };
  constructor(readonly root: string) { }
  async load(): Promise<void> { await this.refresh(false); }
  get book(): Book { return { root: this.root,name: basename(this.root),tree: this.library.tree() }; }
  async usable(): Promise<boolean> {
    const marker=await readOptional(join(this.root,MARKER_FILE));
    return isUsable(storyState({ valid: true,exists: true,marked: marker!==undefined&&parseMarker(marker)!==undefined,hasFiles: !this.library.empty }));
  }
  start(): void {
    this.watcher=watch(this.root,{ recursive: true },() => {
      clearTimeout(this.timer);
      this.timer=setTimeout(() => { void this.enqueue(() => this.refresh(true)); },60);
    });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result=this.queue.then(operation);
    this.queue=result.then(() => { },() => { });
    return result;
  }
  async read(path: string): Promise<DiskFile> { return { path,text: (await readOptional(join(this.root,path)))??'' }; }
  save(path: string,text: string,base: string,force=false): Promise<SaveResult> {
    return this.enqueue(async () => {
      const disk=await readOptional(join(this.root,path));
      if(!force&&disk!==base) { return { saved: false,disk: disk??'' }; }
      await atomicWrite(join(this.root,path),text);
      this.contents.set(path,text);
      await this.refresh(true);
      return { saved: true };
    });
  }
  private async refresh(notify: boolean): Promise<void> {
    const files=await scanFiles(this.root);
    const entries=await Promise.all(files.map(async path => [path,await readOptional(join(this.root,path))] as const));
    if(this.disposed) { return; }
    const next=new Map(entries.filter((entry): entry is readonly [string,string] => entry[1]!==undefined));
    const library=new Library(defaults['files.bookNames']);
    for(const [path,text] of next) {
      for(const [kind,patterns] of groups) {
        for(const pattern of patterns) {
          if(!matchesGlob(path,pattern)) { continue; }
          if(kind==='lore') { library.setLore(path,text); }
          else { library.addFile(kind as FileKind,path,globRootDepth(pattern)); }
        }
      }
      if(notify&&this.contents.has(path)&&this.contents.get(path)!==text) { this.onFileChanged({ path,text }); }
    }
    if(notify) { for(const path of this.contents.keys()) { if(!next.has(path)) { this.onFileChanged({ path,text: '' }); } } }
    this.contents=next;
    this.library=library;
    if(notify) { this.onChanged(this.book); }
  }
  dispose(): void { this.disposed=true; clearTimeout(this.timer); this.watcher?.close(); }
}
export async function inspectBook(root: string): Promise<{ index?: BookIndex; roots: string[]; }> {
  const canonical=await realpath(root);
  const index=new BookIndex(canonical);
  await index.load();
  if(await index.usable()) { return { index,roots: [] }; }
  index.dispose();
  return { roots: await findStories(canonical) };
}
