import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { initialGhost,transition,type GhostState,type GhostEvent,type Position } from '../renderer/ghost/machine';
const position=(text='他说hello',offset=text.length): Position => ({ text,offset,chapter: true,prose: true });
function machine(p=position()) {
  let state: GhostState={ ...initialGhost(p),focused: true };
  return { get state() { return state; },send(event: GhostEvent) { const result=transition(state,event); state=result.state; return result.actions; } };
}
test('line-end pause requests continuation, including Chinese followed by English',() => {
  const m=machine(); assert.equal(m.send({ type: 'timeout' })[1].type,'request');
});
test('automatic completion excludes mid-line, non-chapters, manual mode and the daily limit',() => {
  for(const p of [position('他说hello',1),{ ...position(),chapter: false }]) { assert.deepEqual(machine(p).send({ type: 'timeout' }),[]); }
  for(const setting of [{ auto: false,limited: false },{ auto: true,limited: true }]) {
    const m=machine(); m.send({ type: 'settings',enabled: true,...setting }); assert.deepEqual(m.send({ type: 'timeout' }),[]);
  }
});
test('manual requests work inside prose and outside chapters despite automatic limits',() => {
  const m=machine({ ...position('正文',1),chapter: false });
  m.send({ type: 'settings',enabled: true,auto: false,limited: true });
  assert.ok(m.send({ type: 'manual' }).some(a => a.type==='request'&&a.manual));
});
test('answer shows; typing abandons and aborts; stale answers never show',() => {
  const m=machine(); m.send({ type: 'timeout' }); const id=m.state.pending!;
  assert.deepEqual(m.send({ type: 'answer',id,text: '灯亮了。' }),[{ type: 'show',text: '灯亮了。' }]);
  const actions=m.send({ type: 'type',position: position('他说hello。') });
  assert.ok(actions.some(a => a.type==='abort'&&a.id===id)); assert.ok(actions.some(a => a.type==='hide'));
  assert.deepEqual(m.send({ type: 'answer',id,text: '旧回答。' }),[]);
});
test('Escape discards; Tab accepts once; command-right accepts a sentence and keeps the rest',() => {
  for(const type of ['escape','tab','sentence'] as const) {
    const m=machine(); m.send({ type: 'timeout' }); m.send({ type: 'answer',id: m.state.pending!,text: '「灯亮了。」\n他抬起头。' });
    const actions=m.send({ type });
    if(type==='escape') { assert.equal(actions.some(a => a.type==='insert'),false); }
    else { assert.deepEqual(actions.find(a => a.type==='insert'),{ type: 'insert',text: type==='tab'? '「灯亮了。」\n他抬起头。':'「灯亮了。」' }); }
    assert.equal(m.state.ghost,type==='sentence'? '\n他抬起头。':'');
  }
});
test('composition hides and aborts, ignores all input-method keys and manual requests',() => {
  const m=machine(); m.send({ type: 'timeout' }); m.send({ type: 'answer',id: m.state.pending!,text: '灯亮了。' });
  const actions=m.send({ type: 'compositionStart' }); assert.ok(actions.some(a => a.type==='abort')); assert.ok(actions.some(a => a.type==='hide'));
  for(const type of ['timeout','tab','escape','manual','sentence'] as const) { assert.deepEqual(m.send({ type }),[]); }
  assert.deepEqual(m.send({ type: 'type',position: position('ni') }),[]);
  assert.deepEqual(m.send({ type: 'answer',id: 1,text: '迟到' }),[]);
});
test('composition commit restarts debounce, cancelled composition reuses the old ghost without a request',() => {
  const m=machine(); m.send({ type: 'timeout' }); m.send({ type: 'answer',id: m.state.pending!,text: '灯亮了。' });
  m.send({ type: 'compositionStart' });
  assert.deepEqual(m.send({ type: 'compositionEnd',position: position() }),[{ type: 'show',text: '灯亮了。' }]);
  m.send({ type: 'compositionStart' });
  assert.deepEqual(m.send({ type: 'compositionEnd',position: position('他说你好') }),[{ type: 'timer' }]);
});
test('switching off aborts and prevents automatic and manual requests',() => {
  const m=machine(); m.send({ type: 'timeout' });
  assert.ok(m.send({ type: 'settings',enabled: false,auto: true,limited: false }).some(a => a.type==='abort'));
  assert.deepEqual(m.send({ type: 'timeout' }),[]); assert.deepEqual(m.send({ type: 'manual' }),[]);
});
test('blur clears pending work and failures do not display',() => {
  const m=machine(); m.send({ type: 'timeout' }); const id=m.state.pending!;
  assert.ok(m.send({ type: 'blur' }).some(a => a.type==='abort'));
  assert.deepEqual(m.send({ type: 'failure',id }),[]); assert.deepEqual(m.send({ type: 'answer',id,text: '晚了。' }),[]);
});
test('provider or model changes invalidate cached ghost text and abort the old request',() => {
  const m=machine(); m.send({ type: 'timeout' }); m.send({ type: 'answer',id: m.state.pending!,text: '原来的回答。' });
  const actions=m.send({ type: 'settings',enabled: true,auto: true,limited: false,invalidate: true });
  assert.equal(m.state.cached,undefined); assert.ok(actions.some(a => a.type==='hide')); assert.ok(actions.some(a => a.type==='abort'));
  assert.ok(m.send({ type: 'timeout' }).some(a => a.type==='request'));
});
