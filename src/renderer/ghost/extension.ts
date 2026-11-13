import { Annotation,Prec,StateEffect,StateField,type Extension } from '@codemirror/state';
import { Decoration,EditorView,WidgetType,keymap,type DecorationSet } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { initialGhost,transition,type GhostEvent,type GhostState,type Position } from './machine';
import type { AppAPI } from '../../shared/api';
export const ghostInsertion=Annotation.define<boolean>();
const setGhost=StateEffect.define<{ at: number; text: string; }>();
class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget): boolean { return this.text===other.text; }
  toDOM(): HTMLElement {
    const span=document.createElement('span'); span.className='ghost-text'; span.textContent=this.text;
    span.setAttribute('aria-hidden','true'); span.contentEditable='false'; return span;
  }
  get lineBreaks(): number { return this.text.split('\n').length-1; }
  ignoreEvent(): boolean { return true; }
}
const ghosts=StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value,tr) {
    value=value.map(tr.changes);
    for(const effect of tr.effects) {
      if(effect.is(setGhost)) { value=effect.value.text? Decoration.set([Decoration.widget({ widget: new GhostWidget(effect.value.text),side: 1 }).range(effect.value.at)]):Decoration.none; }
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});
let requestSerial=0;
export class GhostController {
  private state: GhostState;
  private timer?: ReturnType<typeof setTimeout>;
  private view?: EditorView;
  private disposed=false;
  private configuration?: string;
  constructor(private readonly path: string,private readonly chapter: boolean,private readonly api: AppAPI,private debounceMs: number) {
    this.state=initialGhost({ text: '',offset: 0,chapter,prose: /\.(md|txt)$/.test(path) });
  }
  attach(view: EditorView): void { this.view=view; this.state.position=this.position(); }
  private position(): Position {
    return { text: this.view!.state.doc.toString(),offset: this.view!.state.selection.main.head,chapter: this.chapter,prose: /\.(md|txt)$/.test(this.path) };
  }
  settings(enabled: boolean,auto: boolean,limited: boolean,debounceMs: number,configuration: string): void {
    this.debounceMs=debounceMs;
    const invalidate=this.configuration!==undefined&&this.configuration!==configuration;
    this.configuration=configuration;
    this.send({ type: 'settings',enabled,auto,limited,invalidate });
  }
  send(event: GhostEvent): boolean {
    if(this.disposed) { return false; }
    this.state.serial=Math.max(this.state.serial,requestSerial);
    const { state,actions }=transition(this.state,event);
    requestSerial=state.serial;
    this.state=state;
    for(const action of actions) {
      switch(action.type) {
        case 'clearTimer': clearTimeout(this.timer); break;
        case 'timer': clearTimeout(this.timer); this.timer=setTimeout(() => this.send({ type: 'timeout' }),this.debounceMs); break;
        case 'abort': this.api.completion.cancel(action.id); break;
        case 'hide': this.view?.dispatch({ effects: setGhost.of({ at: 0,text: '' }) }); break;
        case 'show': this.view?.dispatch({ effects: setGhost.of({ at: this.state.position.offset,text: action.text }) }); break;
        case 'insert': {
          const at=this.view!.state.selection.main.head;
          this.view!.dispatch({ changes: { from: at,insert: action.text },selection: { anchor: at+action.text.length },annotations: [ghostInsertion.of(true),isolateHistory.of('full')],userEvent: 'input.complete' });
          break;
        }
        case 'request':
          void this.api.completion.request({ id: action.id,path: this.path,text: action.position.text,offset: action.position.offset,manual: action.manual }).then(result => {
            this.send(result.status==='ok'? { type: 'answer',id: action.id,text: result.text }:{ type: 'failure',id: action.id });
          }); break;
      }
    }
    return actions.some(action => action.type==='insert'||action.type==='hide'||action.type==='abort'||action.type==='request');
  }
  extension(): Extension {
    return [ghosts,Prec.highest(keymap.of([
      { key: 'Tab',run: () => this.send({ type: 'tab' }) },
      { key: 'Mod-ArrowRight',run: () => this.send({ type: 'sentence' }) },
      { key: 'Escape',run: () => this.send({ type: 'escape' }) },
      { key: 'Alt-\\',run: () => this.send({ type: 'manual' }) }
    ])),EditorView.domEventHandlers({
      compositionstart: () => { this.send({ type: 'compositionStart' }); return false; },
      compositionend: () => { queueMicrotask(() => { if(!this.disposed) { this.send({ type: 'compositionEnd',position: this.position() }); } }); return false; },
      focus: () => { queueMicrotask(() => this.send({ type: 'focus' })); return false; },
      blur: () => { queueMicrotask(() => this.send({ type: 'blur' })); return false; }
    }),EditorView.updateListener.of(update => {
      if(update.transactions.some(tr => tr.annotation(ghostInsertion))) { return; }
      if(update.docChanged||update.selectionSet) {
        // Dispatch decorations after the editor finishes the originating update.
        queueMicrotask(() => { if(!this.disposed) { this.send({ type: update.docChanged? 'type':'move',position: this.position() }); } });
      }
    })];
  }
  dispose(): void { this.send({ type: 'blur' }); this.disposed=true; clearTimeout(this.timer); }
}
