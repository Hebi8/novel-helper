import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cp,mkdtemp,rm,writeFile,readFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BookIndex,inspectBook,findStories } from '../main/book/indexer';
import { atomicWrite } from '../main/book/files';
import { SettingsStore } from '../main/settings/store';
import { CompletionService } from '../main/completion/service';
import { UsageStore } from '../storage/usageStore';
import { fakeServer,stream,openaiText,OPENAI_END,openaiUsage,sleep } from './fakeServer';
const chapter='正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
async function fixture(t: { after(fn: () => Promise<void>|void): void; }) {
  const root=await mkdtemp(join(tmpdir(),'novel-main-'));
  const book=join(root,'book'); await cp(resolve('examples'),book,{ recursive: true });
  const index=new BookIndex(book); await index.load(); t.after(async () => { index.dispose(); await rm(root,{ recursive: true,force: true }); });
  return { root,book,index };
}
test('examples book uses the extension hierarchy, companions, and lore',async t => {
  const { index }=await fixture(t); assert.equal(await index.usable(),true);
  const tree=index.library.tree(); assert.equal(tree.name,'全书'); assert.equal(tree.outline,'大纲/全书.md');
  const volume=tree.children[0]; assert.equal(volume.name,'第一卷 雾港'); assert.equal(volume.outline,'大纲/第一卷 雾港.md');
  const arc=volume.children[0]; assert.equal(arc.name,'第一幕 来信'); assert.equal(arc.children.length,2);
  assert.equal(arc.children[1].path,chapter); assert.equal(arc.children[1].outline,'大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.md');
  assert.equal(arc.children[0].summary,'摘要/第1章 雾里来信.md'); assert.equal(index.library.entries().length,8);
});
test('unusable folders discover marked stories, excluding hidden/dependencies and levels deeper than four',async t => {
  const { root,book }=await fixture(t);
  await mkdir(join(book,'.novel-helper'),{ recursive: true }); await writeFile(join(book,'.novel-helper/project.json'),'{"version":1}');
  for(const path of ['nested/one/two/book','a/b/c/d/deep','node_modules/book','.hidden/book']) {
    await mkdir(join(root,path,'.novel-helper'),{ recursive: true }); await writeFile(join(root,path,'.novel-helper/project.json'),'{"version":1}');
  }
  const result=await inspectBook(root); assert.equal(result.index,undefined);
  assert.deepEqual(await findStories(root),[book,join(root,'nested/one/two/book')]);
});
test('writes go to a temporary sibling before a rename',async () => {
  const calls: Array<[string,string,string?]>=[];
  await atomicWrite('/tmp/chapter.md','正文',{
    writeFile: (async (path: string,text: string) => { calls.push(['write',path,text]); }) as typeof writeFile,
    rename: async (from,to) => { calls.push(['rename',String(from),String(to)]); }
  });
  assert.equal(calls[0][0],'write'); assert.match(calls[0][1],/^\/tmp\/chapter.md\..+\.tmp$/); assert.equal(calls[0][2],'正文');
  assert.deepEqual(calls[1],['rename',calls[0][1],'/tmp/chapter.md']);
});
test('external edits notify, own writes do not, stale saves report a conflict',async t => {
  const { book,index }=await fixture(t); const changes: string[]=[];
  index.onFileChanged=file => { changes.push(file.text); }; index.start();
  const original=(await index.read(chapter)).text;
  assert.deepEqual(await index.save(chapter,original+'自己写的。',original),{ saved: true });
  await sleep(180); assert.equal(changes.length,0);
  const notified=new Promise<void>(resolve => { index.onFileChanged=file => { changes.push(file.text); resolve(); }; });
  await writeFile(join(book,chapter),'外部写的。'); await notified;
  assert.deepEqual(changes,['外部写的。']);
  assert.deepEqual(await index.save(chapter,'不应覆盖',original),{ saved: false,disk: '外部写的。' });
  assert.equal(await readFile(join(book,chapter),'utf8'),'外部写的。');
});
test('completion sends all outline levels and previous summary, caches an identical automatic request, and honors limits and missing keys',async t => {
  const { root,index }=await fixture(t);
  const server=await fakeServer(res => stream(res,[openaiText('门后传来熟悉的脚步声，灯光照亮了台阶。'),openaiUsage({ prompt_tokens: 40,completion_tokens: 10 }),OPENAI_END])); t.after(() => server.close());
  const settings=new SettingsStore(join(root,'data')); settings.set('provider','openaiCompatible'); settings.set('openaiCompatible.baseUrl',server.baseUrl); settings.set('openaiCompatible.model','test');
  const usage=new UsageStore(join(root,'usage')); await usage.load();
  const service=new CompletionService(settings,usage,() => undefined);
  const text=(await index.read(chapter)).text; const input={ id: 1,path: chapter,text,offset: text.length,manual: false };
  const result=await service.request('one',index,input); assert.equal(result.status,'ok');
  const request=JSON.stringify(server.received[0].body);
  for(const label of ['全书','第一卷 雾港','第一幕 来信','第2章 灯塔','第1章 雾里来信']) { assert.ok(request.includes(label),label); }
  assert.ok(request.includes('林小满')); assert.ok(request.includes('周伯'));
  assert.deepEqual(await service.request('one',index,{ ...input,id: 2 }),result); assert.equal(server.received.length,1);
  await usage.add('test',{ input: 1,output: 1 },2); settings.set('usage.dailyLimitUsd',1);
  assert.equal((await service.request('one',index,{ ...input,id: 3 })).status,'skipped'); assert.equal(service.status().state,'limit');
  assert.equal((await service.request('one',index,{ ...input,id: 4,manual: true })).status,'ok'); assert.equal(server.received.length,2);
  settings.set('usage.dailyLimitUsd',0); settings.set('provider','anthropic');
  assert.equal((await service.request('one',index,{ ...input,id: 5 })).status,'error'); assert.equal(service.status().missingKey,true); assert.equal(server.received.length,2);
  await service.drain();
});
test('cancelled requests still record usage and close before shutdown',async t => {
  const { root,index }=await fixture(t);
  let started!: () => void;
  const sawRequest=new Promise<void>(resolve => { started=resolve; });
  const server=await fakeServer(async res => {
    res.writeHead(200,{ 'content-type': 'text/event-stream' });
    res.write(openaiText('门')); started();
    await new Promise<void>(resolve => res.on('close',resolve));
  });
  const settings=new SettingsStore(join(root,'data')); settings.set('provider','openaiCompatible'); settings.set('openaiCompatible.baseUrl',server.baseUrl); settings.set('openaiCompatible.model','test');
  const usage=new UsageStore(join(root,'usage')); await usage.load();
  const service=new CompletionService(settings,usage,() => undefined);
  const text=(await index.read(chapter)).text;
  const response=service.request('cancel',index,{ id: 1,path: chapter,text,offset: text.length,manual: false });
  await sawRequest; service.cancel('cancel',1);
  assert.equal((await response).status,'cancelled'); await service.drain();
  assert.equal(usage.today().requests,1); assert.equal(usage.today().unknown,1); assert.equal(await server.received[0].closed,true);
  await server.close();
});
