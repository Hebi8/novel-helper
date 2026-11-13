import { useEffect,useRef,useState } from 'react';
import type { Bootstrap,Book,MenuCommand,OpenResult,SessionState } from '../shared/api';
import { LeftSidebar } from './left/LeftSidebar';
import { RightSidebar } from './right/RightSidebar';
import { Tabs } from './tabs/Tabs';
import { StatusBar } from './statusbar/StatusBar';
import { Editor,type EditorHandle } from './editor/Editor';
import { DocumentModel } from './editor/document';
import { zh } from './strings';
import { WorkspaceContext } from './workspace';
export function App() {
  const [initial,setInitial]=useState<Bootstrap>();
  const [book,setBook]=useState<Book>();
  const [session,setSession]=useState<SessionState>({ tabs: [] });
  const sessionRef=useRef(session); sessionRef.current=session;
  const [left,setLeft]=useState(0),[right,setRight]=useState(0);
  const [leftOpen,setLeftOpen]=useState(true),[rightOpen,setRightOpen]=useState(true);
  const [openResult,setOpenResult]=useState<OpenResult>();
  const [error,setError]=useState('');
  const [,redraw]=useState(0);
  const documents=useRef(new Map<string,DocumentModel>());
  const handles=useRef(new Map<string,EditorHandle>());
  const opening=useRef(new Map<string,Promise<DocumentModel>>());
  const load=(path: string) => {
    const existing=documents.current.get(path);
    if(existing) { return Promise.resolve(existing); }
    let pending=opening.current.get(path);
    if(!pending) {
      pending=window.novel.book.read(path).then(file => {
        const model=new DocumentModel(path,file.text,window.novel); model.onChanged=() => redraw(n => n+1);
        documents.current.set(path,model); opening.current.delete(path); return model;
      }); opening.current.set(path,pending);
    }
    return pending;
  };
  const persist=(value: SessionState) => { sessionRef.current=value; setSession(value); void window.novel.window.saveSession(value); };
  const select=(path: string) => { const old=sessionRef.current.active; if(old) { void documents.current.get(old)?.save(); } persist({ ...sessionRef.current,active: path }); };
  const open=async (path: string) => {
    await load(path);
    const current=sessionRef.current;
    if(current.active) { await documents.current.get(current.active)?.save(); }
    persist({ tabs: current.tabs.some(tab => tab.path===path)? current.tabs:[...current.tabs,{ path,anchor: 0,head: 0 }],active: path });
  };
  const close=async (path: string) => {
    const model=documents.current.get(path)!; await model.save();
    if(model.dirty||model.conflict!==undefined||model.error) { select(path); return; }
    const current=sessionRef.current; const index=current.tabs.findIndex(tab => tab.path===path);
    const tabs=current.tabs.filter(tab => tab.path!==path);
    persist({ tabs,active: current.active===path? tabs[Math.min(index,tabs.length-1)]?.path:current.active });
    documents.current.delete(path); model.dispose();
  };
  const commandRef=useRef<(command: MenuCommand) => void>(() => { });
  commandRef.current=command => {
    const current=sessionRef.current;
    const handle=current.active? handles.current.get(current.active):undefined;
    if(command==='closeTab'&&current.active) { void close(current.active); }
    else if(command==='previousTab'||command==='nextTab') {
      const index=current.tabs.findIndex(tab => tab.path===current.active);
      if(current.tabs.length) { select(current.tabs[(index+(command==='nextTab'? 1:-1)+current.tabs.length)%current.tabs.length].path); }
    } else if(command==='find') { handle?.find(); }
    else if(command==='manual') { handle?.ghost.send({ type: 'manual' }); }
    else if(command==='left:toggle') { setLeftOpen(v => !v); }
    else if(command==='right:toggle') { setRightOpen(v => !v); }
    else if(command.startsWith('left:')) { setLeft(Number(command.slice(-1))); setLeftOpen(true); }
    else if(command.startsWith('right:')) { setRight(Number(command.slice(-1))); setRightOpen(true); }
    else if(command==='flush') {
      void Promise.all([...documents.current.values()].map(model => model.save())).then(() => {
        const blocked=[...documents.current.values()].find(model => model.dirty||model.conflict!==undefined||model.error);
        if(blocked) { select(blocked.path); }
        else { window.novel.window.flushed(); }
      });
    }
  };
  useEffect(() => {
    let alive=true;
    void window.novel.window.bootstrap().then(async data => {
      await Promise.all(data.session.tabs.map(tab => load(tab.path)));
      if(alive) { setInitial(data); setBook(data.book); sessionRef.current=data.session; setSession(data.session); }
    }).catch(error => setError(String(error)));
    const unsubscribes=[window.novel.book.onOpenResult(setOpenResult),window.novel.book.onChanged(setBook),window.novel.book.onFileChanged(file => {
      const model=documents.current.get(file.path);
      if(model?.external(file)==='reload') { handles.current.get(file.path)?.reload(); }
    }),window.novel.settings.onChanged(settings => setInitial(value => value? { ...value,settings }:value)),window.novel.usage.onChanged(usage => setInitial(value => value? { ...value,usage }:value)),window.novel.window.onCommand(command => commandRef.current(command))];
    const blur=() => { handles.current.forEach(handle => handle.ghost.send({ type: 'blur' })); documents.current.forEach(model => { void model.save(); }); };
    const focus=() => { const active=sessionRef.current.active; if(active) { handles.current.get(active)?.ghost.send({ type: 'focus' }); } };
    window.addEventListener('blur',blur); window.addEventListener('focus',focus);
    return () => { alive=false; unsubscribes.forEach(unsubscribe => unsubscribe()); window.removeEventListener('blur',blur); window.removeEventListener('focus',focus); documents.current.forEach(model => model.dispose()); };
  },[]);
  const openBook=(root?: string) => { void window.novel.book.open(root).then(setOpenResult).catch(error => setError(String(error))); };
  const active=session.active? documents.current.get(session.active):undefined;
  const count=active? Array.from(active.text.replace(/\s/gu,'')).length:0;
  const selection = session.tabs.find(tab => tab.path === session.active);
  return <WorkspaceContext value={{ book, session, current: active && selection ? { path: active.path, text: active.text, anchor: selection.anchor, head: selection.head } : undefined, open, saveAll: async () => {
    await Promise.all([...documents.current.values()].map(model => model.save()));
    return [...documents.current.values()].every(model => !model.dirty && model.conflict === undefined && !model.error);
  } }}><div className="app"><header className="topbar"><button aria-label={zh.left} onClick={() => setLeftOpen(v => !v)}><PanelIcon /></button><strong>{book?.name??zh.app}</strong><span className="grow" /><button aria-label={zh.settings} onClick={() => { void window.novel.settings.open(); }}>☼</button><button aria-label={zh.right} onClick={() => setRightOpen(v => !v)}><PanelIcon right /></button></header>
    {error? <div className="notice" role="alert">{error}</div>:null}
    {book&&openResult?.kind==='choices'? <div className="notice">{openResult.roots.map(root => <button key={root} onClick={() => openBook(root)}>{root}</button>)}</div>:book&&openResult?.kind==='empty'? <div className="notice">{zh.empty}</div>:null}
    {book&&initial? <div className="workspace">{leftOpen? <LeftSidebar book={book} selected={session.active} section={left} select={setLeft} open={path => { void open(path); }} />:null}<main className="writing"><Tabs tabs={session.tabs} active={session.active} select={select} close={path => { void close(path); }} />
      {active?.conflict!==undefined? <div className="notice" role="alert"><span>{zh.conflict}</span><button onClick={() => { void active.save(true); }}>{zh.keepMine}</button><button onClick={() => { active.useDisk(); handles.current.get(active.path)?.reload(); }}>{zh.useDisk}</button></div>:null}
      {active?.error? <div className="notice" role="alert">{active.error}</div>:null}
      {session.tabs.map(tab => <Editor key={tab.path} document={documents.current.get(tab.path)!} tab={tab} active={tab.path===session.active} chapter={isChapter(book.tree,tab.path)} settings={initial.settings} limited={initial.usage.state==='limit'} ready={handle => { if(handle) { handles.current.set(tab.path,handle); } else { handles.current.delete(tab.path); } }} cursor={(anchor,head) => { const current=sessionRef.current; persist({ ...current,tabs: current.tabs.map(t => t.path===tab.path? { ...t,anchor,head }:t) }); }} />)}
    </main>{rightOpen? <RightSidebar section={right} select={setRight} />:null}</div>:<main className="welcome"><h1>{zh.app}</h1><button className="open-folder" onClick={() => openBook()}>{zh.openFolder}</button>{initial?.recent.length? <section><h2>{zh.recent}</h2>{initial.recent.map(root => <button key={root} onClick={() => openBook(root)}>{root.split('/').pop()}</button>)}</section>:null}{openResult?.kind==='choices'? <section><h2>{zh.chooseStory}</h2>{openResult.roots.map(root => <button key={root} onClick={() => openBook(root)}>{root}</button>)}</section>:openResult?.kind==='empty'? <p>{zh.empty}</p>:null}</main>}
    {initial? <StatusBar status={initial.usage} words={count} toggle={() => { if(initial.usage.missingKey) { void window.novel.settings.open(); } else { void window.novel.settings.set('enabled',!initial.settings.enabled); } }} />:null}
  </div></WorkspaceContext>;
}
function isChapter(node: Book['tree'],path: string): boolean { return node.kind==='chapter'&&node.path===path||node.children.some(child => isChapter(child,path)); }
function PanelIcon({ right=false }: { right?: boolean; }) { return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d={`M${right? 12.5:7.5} 3.5v13`} /></svg>; }
