import { buildContext } from '../../core/context';
import { buildHttpRequest,complete } from '../../llm/client';
import { costOf,ratesFor,usageKey } from '../../core/usage';
import type { SettingsStore } from '../settings/store';
import type { BookIndex } from '../book/indexer';
import type { UsageStore } from '../../storage/usageStore';
import type { CompletionInput,CompletionResult,UsageStatus } from '../../shared/api';
import type { ProviderId } from '../../llm/providers';
const LINE_END_REST=/^[\s」』”’）)】》〉"'。！？!?…]*$/;
export class CompletionService {
  private running=new Map<string,AbortController>();
  private lastShown=new Map<string,{ key: string; text: string; }>();
  private active=0;
  private closed=new Map<string,Promise<void>>();
  private writes=new Set<Promise<void>>();
  private problem?: string;
  private missingKey=false;
  onChanged: (status: UsageStatus) => void=() => { };
  constructor(readonly settings: SettingsStore,readonly usage: UsageStore,private readonly getKey: (provider: ProviderId) => string|undefined) {
    usage.onDidChange(() => this.publish());
  }
  status(): UsageStatus {
    return { state: !this.settings.get().enabled? 'off':this.active? 'requesting':this.problem? 'problem':this.usage.overLimit(this.settings.get()['usage.dailyLimitUsd'])? 'limit':'on',problem: this.problem,missingKey: this.missingKey,today: this.usage.today() };
  }
  publish(): void { this.onChanged(this.status()); }
  settingsChanged(): void {
    this.problem=undefined; this.missingKey=false; this.lastShown.clear();
    for(const controller of this.running.values()) { controller.abort(); }
    this.publish();
  }
  cancel(owner: string,id?: number): void {
    for(const [key,controller] of this.running) {
      if(id===undefined? key.startsWith(`${owner}:`):key===`${owner}:${id}`) { controller.abort(); }
    }
  }
  async drain(owner?: string): Promise<void> {
    if(owner) { this.cancel(owner); }
    else { for(const controller of this.running.values()) { controller.abort(); } }
    await Promise.all([...this.closed].filter(([key]) => !owner||key.startsWith(`${owner}:`)).map(([,done]) => done));
    await Promise.all(this.writes);
  }
  async request(owner: string,index: BookIndex,input: CompletionInput): Promise<CompletionResult> {
    const c=this.settings.get();
    const before=input.text.slice(0,input.offset);
    const after=input.text.slice(input.offset);
    const lineAfter=after.split('\n',1)[0];
    if(!c.enabled||!/\.(md|txt)$/.test(input.path)||(!input.manual&&(c.trigger==='manual'||!index.library.isChapter(input.path)||!LINE_END_REST.test(lineAfter)))) { return { status: 'skipped' }; }
    if(!input.manual&&this.usage.overLimit(c['usage.dailyLimitUsd'])) { this.publish(); return { status: 'skipped' }; }
    const requestId=`${owner}:${input.id}`;
    const controller=new AbortController();
    this.running.set(requestId,controller);
    let resolveClosed!: () => void;
    this.closed.set(requestId,new Promise(resolve => { resolveClosed=resolve; }));
    const finish=() => { if(this.running.get(requestId)===controller) { this.running.delete(requestId); } this.closed.delete(requestId); resolveClosed(); };
    let requesting=false;
    try {
      const model=this.settings.model();
      const apiKey=this.getKey(model.provider);
      if(model.keyRequired&&!apiKey) {
        this.problem='missingKey'; this.missingKey=true; this.publish(); finish();
        return { status: 'error',error: 'missingKey' };
      }
      const limits=this.settings.limits();
      const library=index.library;
      const read=async (path: string) => (await index.read(path)).text;
      const outlinePath=library.companionOf('outline',input.path);
      const [levels,outline,previous]=await Promise.all([
        Promise.all(library.levelsOf(input.path).map(async level => ({ name: level.name,book: level.path==='',outline: level.outline? { path: level.outline,content: await read(level.outline) }:undefined }))),
        outlinePath? read(outlinePath).then(content => ({ path: outlinePath,content })):undefined,
        Promise.all(library.previousChapters(input.path,limits.previousChapters).map(async path => {
          const summary=library.companionOf('summary',path);
          return summary? { path,summary: await read(summary) }:{ path,text: await read(path) };
        }))
      ]);
      await this.usage.load();
      if(controller.signal.aborted||!this.settings.get().enabled) { finish(); return { status: 'cancelled' }; }
      if(!input.manual&&this.usage.overLimit(this.settings.get()['usage.dailyLimitUsd'])) { finish(); this.publish(); return { status: 'skipped' }; }
      const { prompt }=buildContext({ documentPath: input.path,before,after,maxChars: c.maxSuggestionChars,entries: library.entries(),matcher: library.matcher(),levels,outline,previous,limits });
      const request={ ...model,apiKey,...prompt };
      const { url,body }=buildHttpRequest(request);
      const key=JSON.stringify([url,body,c.maxSuggestionChars]);
      const cached=this.lastShown.get(owner);
      if(!input.manual&&cached?.key===key) { finish(); return { status: 'ok',text: cached.text }; }
      const rates=ratesFor(model.model,new Date(),model.pricing,this.settings.prices());
      this.active++; requesting=true; this.problem=undefined; this.missingKey=false; this.publish();
      const outcome=await complete(request,{
        signal: controller.signal,before,after: lineAfter,maxChars: c.maxSuggestionChars,
        onUsage: usage => {
          const write=this.usage.add(usageKey(model.provider,model.model),usage,rates? costOf(usage,rates):undefined);
          this.writes.add(write); void write.then(() => this.writes.delete(write),error => { this.writes.delete(write); this.problem=String(error); this.publish(); });
        },
        onClose: finish
      });
      this.active--; requesting=false; this.problem=outcome.status==='error'? outcome.error:undefined; this.publish();
      if(controller.signal.aborted||outcome.status==='cancelled') { return { status: 'cancelled' }; }
      if(outcome.status!=='ok') { return { status: 'error',error: outcome.error }; }
      this.lastShown.set(owner,{ key,text: outcome.text });
      return { status: 'ok',text: outcome.text };
    } catch(error) {
      if(requesting) { this.active--; }
      finish(); this.problem=String(error); this.publish();
      return { status: 'error',error: this.problem };
    }
  }
}
