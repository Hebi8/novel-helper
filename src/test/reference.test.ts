import fs = require('node:fs/promises');
import { describeBuoy } from '../renderer/strings';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Text } from '@codemirror/state';
import { Buoys } from '../main/buoys/service';
import { BookIndex } from '../main/book/indexer';
import { SettingsStore } from '../main/settings/store';
import { UsageStore } from '../storage/usageStore';
import { CompletionService } from '../main/completion/service';
import { createLore, setLoreField, openCompanion, quickItems, referenceData } from '../main/reference/service';
import { buoyPath, choices, inNode, markAt, serializeBuoyFile, stateOf, BUOY_VERSION, JUDGE_INSTRUCTIONS } from '../core/buoy';
import { parseLoreEntry } from '../core/library';
import { rankQuick } from '../renderer/reference/quick';
import { VisibleLore } from '../renderer/reference/matches';
import { DocumentModel } from '../renderer/editor/document';
import type { AppAPI } from '../shared/api';
import type { ask, ModelRequest } from '../llm/client';
import { openaiText, openaiUsage, OPENAI_END } from './fakeServer';
const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
const mirror = '大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), 'novel-reference-'));
	const book = join(root, 'book');
	await cp(resolve('examples'), book, { recursive: true });
	const index = new BookIndex(book);
	await index.load();
	const settings = new SettingsStore(join(root, 'data'));
	settings.set('provider', 'openaiCompatible');
	settings.set('openaiCompatible.model', 'test');
	const usage = new UsageStore(join(root, 'usage'));
	await usage.load();
	let answer = '0';
	let reply: (() => Promise<Awaited<ReturnType<typeof ask>>>) | undefined;
	const requests: ModelRequest[] = [];
	const buoys = new Buoys(
		index,
		settings,
		usage,
		() => undefined,
		async (request) => {
			requests.push(request);
			return reply ? reply() : { text: answer, usage: { input: 10, output: 1 } };
		},
	);
	t.after(async () => {
		await buoys.dispose();
		index.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const seed = async (path: string, content: string) => {
		await mkdir(dirname(join(book, path)), { recursive: true });
		await writeFile(join(book, path), content);
		await index.refresh(path);
	};
	const marks = async () => JSON.parse(await readFile(join(book, buoyPath(chapter)), 'utf8'));
	return {
		root,
		book,
		index,
		settings,
		usage,
		buoys,
		requests,
		seed,
		marks,
		answer: (value: string) => {
			answer = value;
		},
		reply: (value: typeof reply) => {
			reply = value;
		},
	};
}
test('starting chapter inherits the previous chapter last position without asking', async (t) => {
	const f = await fixture(t);
	await rm(join(f.book, buoyPath(chapter)));
	const previous = f.index.library.previousChapters(chapter, 1)[0];
	const leaf = (await f.index.outline()).leaves[0];
	await f.seed(
		buoyPath(previous),
		serializeBuoyFile({
			version: BUOY_VERSION,
			chapter: previous,
			marks: [markAt('上章', 2, stateOf(inNode(leaf)), 'manual', new Date())],
		}),
	);
	const at = await f.buoys.prepare(chapter, '新章');
	assert.equal(at.position?.nodes[0].id, leaf.id);
	assert.equal(at.file?.marks[0].by, 'init');
	assert.equal(f.requests.length, 0);
});
test('starting chapter without previous buoy uses the matching outline first leaf even when updates are off', async (t) => {
	const f = await fixture(t);
	await rm(join(f.book, '.novel-helper/buoys'), { recursive: true });
	f.settings.set('position.updateChars', 0);
	const at = await f.buoys.prepare(chapter, '新章');
	assert.equal(at.position?.nodes[0].title, '等门');
	f.buoys.update(at, '长'.repeat(2000));
	await f.buoys.drain();
	assert.equal(f.requests.length, 0);
});
test('net growth threshold, one connected step, and position usage recorded separately', async (t) => {
	const f = await fixture(t);
	f.settings.set('position.updateChars', 10);
	const at = await f.buoys.read(chapter);
	const count = at.file!.marks.at(-1)!.chars;
	for (const length of [count - 3, count, count + 9]) {
		f.buoys.update(at, '文'.repeat(length));
	}
	await f.buoys.drain();
	assert.equal(f.requests.length, 0);
	const list = choices(at.graph, at.position!)[0];
	const move = list.find((choice) => choice.to && !choice.bridge)!;
	f.answer(String(list.indexOf(move) + 1));
	f.buoys.update(at, '文'.repeat(count + 10));
	await f.buoys.drain();
	assert.equal(f.requests.length, 1);
	assert.equal((await f.buoys.read(chapter)).position?.nodes[0].id, move.to!.id);
	assert.equal((await f.marks()).marks.at(-1).by, 'auto');
	assert.match(JSON.stringify(f.usage.current()), /position/);
	assert.equal(f.usage.today().requests, 1);
});
test('unreadable judgement stays in place and records the new character baseline', async (t) => {
	const f = await fixture(t);
	const at = await f.buoys.read(chapter);
	f.answer('不是编号');
	f.buoys.update(at, '文'.repeat(1500));
	await f.buoys.drain();
	const after = await f.buoys.read(chapter);
	assert.deepEqual(after.file!.marks.at(-1)!.state, at.file!.marks.at(-1)!.state);
	assert.equal(after.file!.marks.at(-1)!.chars, 1500);
	f.buoys.update(after, '文'.repeat(1501));
	await f.buoys.drain();
	assert.equal(f.requests.length, 1);
});
test('parallel buoys are judged independently using the numbered choices', async (t) => {
	const f = await fixture(t);
	const at = await f.buoys.read(chapter);
	await f.buoys.act(chapter, 'parallel', at.graph.leaves[0].id);
	const parallel = await f.buoys.read(chapter);
	const lists = choices(parallel.graph, parallel.position!);
	f.answer('A1 B2');
	f.buoys.update(parallel, '文'.repeat(2000));
	await f.buoys.drain();
	const after = await f.buoys.read(chapter);
	assert.equal(after.position!.nodes[0].id, parallel.position!.nodes[0].id);
	assert.equal(after.position!.nodes[1].id, lists[1][1].to!.id);
});
test('existing prose without a buoy relocates over all leaves; invalid searches wait for net growth', async (t) => {
	const f = await fixture(t);
	await rm(join(f.book, buoyPath(chapter)));
	let at = await f.buoys.prepare(chapter, '文'.repeat(300));
	assert.equal(at.position, undefined);
	f.answer('不确定');
	f.buoys.update(at, '文'.repeat(300));
	await f.buoys.drain();
	f.buoys.update(at, '文'.repeat(301));
	await f.buoys.drain();
	assert.equal(f.requests.length, 1);
	f.answer('1');
	f.buoys.update(at, '文'.repeat(1300));
	await f.buoys.drain();
	at = await f.buoys.read(chapter);
	assert.equal(at.file!.marks.at(-1)!.by, 'relocate');
	assert.ok(at.position);
});
test('renamed heading is reported lost and searched again', async (t) => {
	const f = await fixture(t);
	const raw = await readFile(join(f.book, mirror), 'utf8');
	await f.seed(mirror, raw.replaceAll('周伯收信', '收到信了'));
	const at = await f.buoys.read(chapter);
	assert.equal(at.lost, true);
	f.answer('1');
	f.buoys.update(at, '文'.repeat(500));
	await f.buoys.drain();
	assert.equal((await f.buoys.read(chapter)).lost, false);
	assert.equal((await f.marks()).marks.at(-1).by, 'relocate');
});
test('manual place, bridge, parallel, drop, forward and back append manual records', async (t) => {
	const f = await fixture(t);
	const graph = await f.index.outline();
	const first = graph.leaves[0];
	const second = graph.leaves[1];
	const before = (await f.marks()).marks.length;
	await f.buoys.act(chapter, 'in', first.id);
	await f.buoys.act(chapter, 'forward');
	assert.equal((await f.buoys.read(chapter)).position!.nodes[0].id, second.id);
	await f.buoys.act(chapter, 'back');
	assert.equal((await f.buoys.read(chapter)).position!.nodes[0].id, first.id);
	await f.buoys.act(chapter, 'bridge', second.id);
	assert.equal((await f.buoys.read(chapter)).position!.kind, 'bridge');
	await f.buoys.act(chapter, 'parallel', second.id);
	assert.equal((await f.buoys.read(chapter)).position!.kind, 'parallel');
	await f.buoys.act(chapter, 'dropSecond');
	assert.equal((await f.buoys.read(chapter)).position!.kind, 'in');
	const after = (await f.marks()).marks;
	assert.equal(after.length, before + 6);
	assert.ok(after.slice(before).every((mark: { by: string }) => mark.by === 'manual'));
});
test('external open marks are completed from chapter text and a following manual append is kept', async (t) => {
	const f = await fixture(t);
	const original = await f.marks();
	const state = original.marks.at(-1).state;
	original.chapter = '../../outside';
	original.marks.push({ by: 'assistant', state });
	await f.seed(buoyPath(chapter), JSON.stringify(original));
	const reading = f.buoys.read(chapter);
	const moving = f.buoys.act(chapter, 'forward');
	await Promise.all([reading, moving]);
	const after = await f.marks();
	assert.equal(after.chapter, chapter);
	assert.equal(after.marks.length, original.marks.length + 1);
	assert.equal(after.marks.at(-2).by, 'assistant');
	assert.equal(after.marks.at(-2).at, (await f.index.read(chapter)).text.length);
	assert.equal(after.marks.at(-1).by, 'manual');
	assert.equal(
		(await readdir(dirname(join(f.book, buoyPath(chapter))))).some((path) => path.endsWith('.tmp')),
		false,
	);
});
for (const gate of ['off', 'key', 'limit'] as const) {
	test(`position requests are suppressed by ${gate}, while manual relocation only requires a key`, async (t) => {
		const f = await fixture(t);
		if (gate === 'off') {
			f.settings.set('enabled', false);
		}
		if (gate === 'key') {
			f.settings.set('provider', 'anthropic');
		}
		if (gate === 'limit') {
			await f.usage.add('test', { input: 1, output: 1 }, 2);
			f.settings.set('usage.dailyLimitUsd', 1);
		}
		f.buoys.update(await f.buoys.read(chapter), '文'.repeat(2000));
		await f.buoys.drain();
		assert.equal(f.requests.length, 0);
		if (gate === 'key') {
			await assert.rejects(f.buoys.act(chapter, 'relocate'));
			assert.equal(f.requests.length, 0);
		} else {
			f.answer('1');
			await f.buoys.act(chapter, 'relocate');
			assert.equal(f.requests.length, 1);
		}
	});
}
test('late model answers cannot replace a manual mark or a changed outline', async (t) => {
	const f = await fixture(t);
	for (const change of ['manual', 'outline']) {
		let release!: (value: { text: string }) => void;
		let asked!: () => void;
		const started = new Promise<void>((resolve) => {
			asked = resolve;
		});
		f.reply(() => {
			asked();
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		const at = await f.buoys.read(chapter);
		f.buoys.update(at, '文'.repeat(5000));
		await started;
		if (change === 'manual') {
			await f.buoys.act(chapter, 'in', at.graph.leaves[0].id);
		} else {
			await f.seed(mirror, (await readFile(join(f.book, mirror), 'utf8')) + '\n更改');
		}
		const before = await readFile(join(f.book, buoyPath(chapter)), 'utf8');
		release({ text: '1' });
		await f.buoys.drain();
		assert.equal(await readFile(join(f.book, buoyPath(chapter)), 'utf8'), before);
	}
});
test('one-field lore edits preserve BOM, CRLF, comments and body; unsupported edits preserve all bytes', async (t) => {
	const f = await fixture(t);
	const path = '人物/字段.md';
	const raw = '\uFEFF---\r\nname: 字段 # name\r\naliases: [旧名] # aliases\r\ntype: 人物 # type\r\n---\r\n正文\r\n';
	await f.seed(path, raw);
	await setLoreField(f.index, path, 'always', true);
	let expected = raw.replace('---\r\n正文', 'always: true\r\n---\r\n正文');
	assert.equal(await readFile(join(f.book, path), 'utf8'), expected);
	await setLoreField(f.index, path, 'aliases', ['新名']);
	expected = expected.replace('[旧名]', '[新名]');
	assert.equal(await readFile(join(f.book, path), 'utf8'), expected);
	await setLoreField(f.index, path, 'type', '物品');
	expected = expected.replace('type: 人物', 'type: 物品');
	assert.equal(await readFile(join(f.book, path), 'utf8'), expected);
	assert.equal(f.index.library.entry(path)!.type, '物品');
	const unsupported = '---\naliases:\n - 甲 # keep this\n - 乙\n---\n正文';
	await f.seed(path, unsupported);
	await assert.rejects(setLoreField(f.index, path, 'aliases', ['丙']), /无法只改/);
	assert.equal(await readFile(join(f.book, path), 'utf8'), unsupported);
});
test('lore writes re-read disk, reject missing paths and do not follow unsafe names', async (t) => {
	const f = await fixture(t);
	const path = '人物/林小满.md';
	await writeFile(join(f.book, path), '磁盘的新正文');
	await setLoreField(f.index, path, 'always', true);
	assert.equal(await readFile(join(f.book, path), 'utf8'), '---\nalways: true\n---\n磁盘的新正文');
	await rm(join(f.book, path));
	await assert.rejects(setLoreField(f.index, path, 'always', false), /不存在/);
	await assert.rejects(setLoreField(f.index, '../outside', 'always', true), /不能超出/);
	await assert.rejects(createLore(f.index, '../outside', '人物'), /名字/);
});
test('new lore uses type template then default, fills YAML names, and refuses overwrite or invalid template', async (t) => {
	const f = await fixture(t);
	await f.seed('.novel-helper/templates/物品.md', '---\nname: {{name}}\ntype: {{type}}\n---\n{{name}}是{{type}}');
	const path = await createLore(f.index, '风: 雨', '物品');
	assert.equal(f.index.library.entry(path)!.name, '风: 雨');
	assert.match(await readFile(join(f.book, path), 'utf8'), /风: 雨是物品/);
	await assert.rejects(createLore(f.index, '风: 雨', '物品'));
	await f.seed('.novel-helper/templates/default.md', '---\nname: {{name}}\n---\n默认正文');
	const fallback = await createLore(f.index, '安全模板', '../../outside');
	assert.match(await readFile(join(f.book, fallback), 'utf8'), /默认正文/);
	await f.seed('.novel-helper/templates/人物.md', '---\nname: [\n---\n坏模板');
	await assert.rejects(createLore(f.index, '不应创建', '人物'));
	assert.equal(
		f.index.library.entries().some((entry) => entry.name === '不应创建'),
		false,
	);
});
test('missing companions are created in matching hierarchy and existing ones are left byte-identical', async (t) => {
	const f = await fixture(t);
	const before = await readFile(join(f.book, mirror));
	assert.equal(await openCompanion(f.index, chapter, 'outline'), mirror);
	assert.deepEqual(await readFile(join(f.book, mirror)), before);
	const summary = await openCompanion(f.index, chapter, 'summary');
	assert.equal(summary, chapter.replace('正文/', '摘要/'));
	assert.equal(await readFile(join(f.book, summary), 'utf8'), '');
	assert.equal(f.index.library.companionOf('summary', chapter), summary);
});
test('quick open includes chapters, lore aliases, outline headings and auxiliary prose with exact-prefix-substring ordering', async (t) => {
	const f = await fixture(t);
	await f.seed('笔记/潮汐研究.txt', '笔记');
	const items = await quickItems(f.index);
	assert.ok(items.some((item) => item.kind === 'chapter' && item.path === chapter));
	assert.ok(items.some((item) => item.kind === 'outline' && item.title === '周伯收信' && item.line! > 0));
	assert.ok(items.some((item) => item.kind === 'file' && item.path === '笔记/潮汐研究.txt'));
	assert.ok(rankQuick(items, '潮汐').some((item) => item.title === '潮汐钟'));
	const lore = items.find((item) => item.aliases.length)!;
	assert.equal(rankQuick(items, lore.aliases[0])[0].path, lore.path);
	const source = ['前潮汐后', '潮汐研究', '潮汐'].map((title) => ({ id: title, path: title, title, kind: 'file' as const, aliases: [] }));
	assert.deepEqual(
		rankQuick(source, '潮汐').map((item) => item.title),
		['潮汐', '潮汐研究', '前潮汐后'],
	);
});
test('visible lore matches use longest names, whole English words, shared aliases and visible lines only', () => {
	const entries = [
		parseLoreEntry('人物/张三.md', ''),
		parseLoreEntry('人物/张三丰.md', ''),
		parseLoreEntry('人物/Al.md', ''),
		parseLoreEntry('人物/其他.md', '---\naliases: [张三丰]\n---\n'),
	];
	const text = Text.of(['屏外张三', '张三丰张三 Also AL', '屏外张三']);
	const visible = text.line(2);
	const matches = new VisibleLore(entries).find(text, [{ from: visible.from, to: visible.to }]);
	assert.deepEqual(
		matches.map((match) => match.key),
		['张三丰', '张三', 'Al'],
	);
	assert.equal(matches[0].ids.length, 2);
	assert.ok(matches.every((match) => match.start >= visible.from && match.end <= visible.to));
});
test('reference data has no cycles and reports unresolved links and example buoy', async (t) => {
	const f = await fixture(t);
	await f.seed(mirror, (await readFile(join(f.book, mirror), 'utf8')) + '\n→ 不存在\n');
	const data = await referenceData(f.index);
	assert.doesNotThrow(() => JSON.stringify(data));
	assert.ok(data.nodes.some((node) => node.links.some((link) => link.problem === 'missing')));
	assert.equal((await f.buoys.status(chapter)).state!.nodes[0].title, '周伯收信');
});
test('continuation request contains buoy, ancestors and next node; report is Chinese and read-only documents never save', async (t) => {
	const f = await fixture(t);
	const requests: string[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		requests.push(String(init.body));
		return new Response(openaiText('门后传来一声叹息。') + openaiUsage({ prompt_tokens: 12, completion_tokens: 5 }) + OPENAI_END, {
			headers: { 'content-type': 'text/event-stream' },
		});
	});
	const service = new CompletionService(f.settings, f.usage, () => undefined);
	const text = (await f.index.read(chapter)).text;
	assert.equal((await service.request('one', f.index, { id: 1, path: chapter, text, offset: text.length, manual: true })).status, 'ok');
	await service.drain();
	assert.equal(requests.length, 1);
	const body = requests[0];
	for (const title of ['周伯收信', '商量渡海', '第一幕 来信', '全书']) {
		assert.ok(body.includes(title), title);
	}
	assert.equal(body.includes(JUDGE_INSTRUCTIONS), false);
	const report = await service.report('one', 'report');
	assert.match(report, /周伯收信/);
	assert.match(report, /提示词/);
	const usage = await service.report('one', 'usageReport');
	assert.match(usage, /今天/);
	assert.match(usage, /本月/);
	let writes = 0;
	const model = new DocumentModel(
		'report:last-request',
		report,
		{
			book: {
				save: () => {
					writes++;
				},
			},
		} as unknown as AppAPI,
		true,
	);
	model.edit('更改');
	await model.save();
	assert.equal(model.text, report);
	assert.equal(writes, 0);
});

test('continuation does not wait for background position judgement and sends both with the same model', async (t) => {
	const f = await fixture(t);
	f.settings.set('position.updateChars', 10);
	let release!: () => void;
	let seen!: () => void;
	const positionStarted = new Promise<void>((resolve) => {
		seen = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const bodies: Record<string, unknown>[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		bodies.push(body);
		const position = JSON.stringify(body).includes('记录写作进度');
		if (position) {
			seen();
			await pending;
		}
		return new Response(
			openaiText(position ? '3' : '门外又响起脚步。') + openaiUsage({ prompt_tokens: 20, completion_tokens: 6 }) + OPENAI_END,
		);
	});
	const service = new CompletionService(f.settings, f.usage, () => undefined);
	const text = '正文'.repeat(230);
	const result = await service.request('background', f.index, { id: 1, path: chapter, text, offset: text.length, manual: true });
	assert.equal(result.status, 'ok');
	await positionStarted;
	assert.equal(bodies.length, 2);
	assert.ok(bodies.every((body) => body.model === 'test'));
	assert.equal((await f.buoys.status(chapter)).state!.nodes[0].title, '周伯收信');
	release();
	await service.buoys(f.index).drain();
	await service.drain();
	assert.equal((await f.buoys.status(chapter)).state!.nodes[0].title, '商量渡海');
	assert.equal(f.usage.today().requests, 2);
	assert.match(await service.report('background', 'usageReport'), /大纲定位/);
});

test('explicit relocation works when periodic updates are disabled', async (t) => {
	const f = await fixture(t);
	f.settings.set('position.updateChars', 0);
	f.answer('1');
	await f.buoys.act(chapter, 'relocate');
	assert.equal(f.requests.length, 1);
	assert.equal((await f.marks()).marks.at(-1).by, 'relocate');
});

test('lore index changes immediately after save, create and delete', async (t) => {
	const f = await fixture(t);
	const path = await createLore(f.index, '新人物', '人物');
	assert.ok(f.index.library.matcher().at('新人物', 1));
	const raw = (await f.index.read(path)).text;
	assert.equal((await f.index.save(path, raw.replace('aliases: []', 'aliases: [小新人]'), raw)).saved, true);
	assert.ok(f.index.library.matcher().at('小新人', 1));
	await rm(join(f.book, path));
	await f.index.refresh(path);
	assert.equal(f.index.library.matcher().at('新人物', 1), undefined);
	assert.equal(f.index.library.matcher().at('小新人', 1), undefined);
});

test('visible matches cover separate ranges of one line without duplicate decorations', () => {
	const text = Text.of(['张三经过张三又遇见张三']);
	const matches = new VisibleLore([parseLoreEntry('人物/张三.md', '')]).find(text, [
		{ from: 0, to: 2 },
		{ from: 8, to: 11 },
	]);
	assert.deepEqual(
		matches.map((match) => match.start),
		[0, 9],
	);
});

test('simultaneous first continuation preparations append only one initial mark', async (t) => {
	const f = await fixture(t);
	await rm(join(f.book, buoyPath(chapter)));
	await Promise.all([f.buoys.prepare(chapter, '开头'), f.buoys.prepare(chapter, '开头')]);
	assert.equal((await f.marks()).marks.length, 1);
});

test('open marks use the current unsaved chapter text supplied by continuation', async (t) => {
	const f = await fixture(t);
	const file = await f.marks();
	file.marks.push({ by: 'assistant', state: file.marks.at(-1).state });
	await f.seed(buoyPath(chapter), JSON.stringify(file));
	const text = (await f.index.read(chapter)).text + '还没自动保存的正文';
	await f.buoys.prepare(chapter, text);
	const after = await f.marks();
	assert.equal(after.marks.at(-1).at, text.length);
	assert.ok(after.marks.at(-1).before.endsWith('还没自动保存的正文'));
});

test('CR-only frontmatter is not rewritten by the LF/CRLF field editor', async (t) => {
	const f = await fixture(t);
	const path = '人物/旧换行.md';
	const text = '---\rtype: 人物\r---\r正文\r';
	await f.seed(path, text);
	await assert.rejects(setLoreField(f.index, path, 'always', true), /无法只改/);
	assert.equal(await readFile(join(f.book, path), 'utf8'), text);
});

test('reference revision changes only for lore and outline content, not chapter saves', async (t) => {
	const f = await fixture(t);
	const version = f.index.book.referenceVersion;
	const original = (await f.index.read(chapter)).text;
	await f.index.save(chapter, original + '字', original);
	await f.index.refresh(chapter);
	assert.equal(f.index.book.referenceVersion, version);
	const lore = '人物/林小满.md';
	const text = (await f.index.read(lore)).text;
	await f.index.save(lore, text + '改变了设定', text);
	const changed = f.index.book.referenceVersion!;
	assert.ok(changed > version!);
	await f.index.refresh(lore);
	assert.equal(f.index.book.referenceVersion, changed);
});

test('quick-open candidate ids distinguish an outline file from its first-line heading', async (t) => {
	const f = await fixture(t);
	const items = await quickItems(f.index);
	assert.equal(new Set(items.map((item) => item.id)).size, items.length);
	const firstLine = items.filter((item) => item.path === mirror && item.line === 0);
	assert.ok(firstLine.length > 1);
	assert.equal(new Set(firstLine.map((item) => item.id)).size, firstLine.length);
	const filtered = rankQuick(items, '第2章');
	assert.ok(filtered.every((item) => [item.title, ...item.aliases].some((name) => name.includes('第2章'))));
});

test('unreadable outlines stay listed while lore, buoys and continuation still work', async (t) => {
	const f = await fixture(t);
	for (const [path, raw] of [
		['大纲/mixed.md', Buffer.from('甲\r\n乙\n')],
		['大纲/bytes.md', Buffer.from([255])],
	] as const) {
		await writeFile(join(f.book, path), raw);
		await f.index.refresh(path);
		await assert.rejects(f.index.read(path));
	}
	await f.seed('大纲/全书.md', '甲\r\n乙\n');
	const data = await referenceData(f.index);
	assert.ok(data.outlines.includes('大纲/mixed.md'));
	assert.ok(data.outlines.includes('大纲/bytes.md'));
	assert.ok(!data.nodes.some((node) => ['大纲/mixed.md', '大纲/bytes.md'].includes(node.file ?? '')));
	assert.ok(data.entries.some((entry) => entry.name === '林小满'));
	assert.equal((await f.buoys.status(chapter)).state!.nodes[0].title, '周伯收信');
	assert.ok((await quickItems(f.index)).some((item) => item.path === '大纲/mixed.md'));
	t.mock.method(globalThis, 'fetch', async () => new Response(openaiText('门里传来声音。') + OPENAI_END));
	const service = new CompletionService(f.settings, f.usage, () => undefined);
	const text = (await f.index.read(chapter)).text;
	assert.equal(
		(await service.request('bad-outline', f.index, { id: 1, path: chapter, text, offset: text.length, manual: true })).status,
		'ok',
	);
	await service.drain();
});

test('opening existing companions preserves inode, mtime and symbolic links', async (t) => {
	const f = await fixture(t);
	const { lstat, symlink } = await import('node:fs/promises');
	const file = join(f.book, mirror);
	const before = await lstat(file);
	await openCompanion(f.index, chapter, 'outline');
	const after = await lstat(file);
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeMs, before.mtimeMs);
	const summary = chapter.replace('正文/', '摘要/');
	await mkdir(dirname(join(f.book, summary)), { recursive: true });
	await writeFile(join(f.book, 'summary-target.md'), '摘要');
	await symlink(join(f.book, 'summary-target.md'), join(f.book, summary));
	await f.index.refresh(summary);
	const link = await lstat(join(f.book, summary));
	await openCompanion(f.index, chapter, 'summary');
	assert.equal((await lstat(join(f.book, summary))).ino, link.ino);
	assert.ok((await lstat(join(f.book, summary))).isSymbolicLink());
});

test('blank previous-chapter summaries use the chapter ending in continuation context', async (t) => {
	const f = await fixture(t);
	const previous = f.index.library.previousChapters(chapter, 1)[0];
	const summary = f.index.library.companionOf('summary', previous)!;
	await f.seed(summary, '  \n\t');
	await f.seed(previous, '前章结尾仍然应该进入上下文。');
	let sent = '';
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		sent = String(init.body);
		return new Response(openaiText('新的正文。') + OPENAI_END);
	});
	const service = new CompletionService(f.settings, f.usage, () => undefined);
	const text = (await f.index.read(chapter)).text;
	await service.request('empty-summary', f.index, { id: 1, path: chapter, text, offset: text.length, manual: true });
	await service.drain();
	assert.match(sent, /前章结尾仍然应该进入上下文/);
});

test('closing a book aborts an in-flight position transport without waiting or appending a mark', async (t) => {
	const f = await fixture(t);
	let signal!: AbortSignal;
	let started!: () => void;
	const begun = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
		signal = init.signal!;
		started();
		return new Promise<Response>((_resolve, reject) =>
			signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }),
		);
	});
	const service = new CompletionService(f.settings, f.usage, () => undefined);
	const buoy = service.buoys(f.index);
	const before = await readFile(join(f.book, buoyPath(chapter)), 'utf8');
	buoy.update(await buoy.read(chapter), '文'.repeat(2000));
	await begun;
	await service.closeBook(f.book);
	assert.equal(signal.aborted, true);
	await buoy.drain();
	assert.equal(await readFile(join(f.book, buoyPath(chapter)), 'utf8'), before);
});

test('request and usage reports translate the empty state and daily limit', async (t) => {
	const f = await fixture(t);
	const service = new CompletionService(f.settings, f.usage, () => undefined);
	assert.doesNotMatch(await service.report('new', 'report'), /Pause at the end/);
	f.settings.set('usage.dailyLimitUsd', 3);
	const report = await service.report('new', 'usageReport');
	assert.match(report, /日上限：\$3/);
	assert.doesNotMatch(report, /Daily limit/);
});

for (const format of ['mixed lines', 'non-UTF8'] as const) {
	test(`an unreadable buoy outline (${format}) preserves marks and recovers after repair`, async (t) => {
		const f = await fixture(t);
		const original = await readFile(join(f.book, mirror));
		const buoyFile = join(f.book, buoyPath(chapter));
		const before = await readFile(buoyFile);
		await writeFile(join(f.book, mirror), format === 'mixed lines' ? Buffer.from('甲\r\n乙\n') : Buffer.from([255]));
		await f.index.refresh(mirror);
		const at = await f.buoys.prepare(chapter, '文'.repeat(2000));
		assert.deepEqual(at.unreadable, [mirror]);
		f.buoys.update(at, '文'.repeat(2000));
		await f.buoys.drain();
		assert.equal(f.requests.length, 0);
		assert.deepEqual(await readFile(buoyFile), before);
		const status = await f.buoys.status(chapter);
		assert.match(describeBuoy(status.state, status.lost, status.unreadable), /读不了/);
		assert.ok(describeBuoy(status.state, status.lost, status.unreadable).includes(mirror));
		await assert.rejects(f.buoys.act(chapter, 'relocate'), /读不了/);
		for (const action of ['forward', 'back'] as const) {
			await assert.rejects(
				f.buoys.act(chapter, action),
				(error) => error instanceof Error && error.message === describeBuoy(status.state, status.lost, status.unreadable),
			);
		}
		assert.equal(f.requests.length, 0);
		await writeFile(join(f.book, mirror), original);
		await f.index.refresh(mirror);
		const restored = await f.buoys.read(chapter);
		assert.deepEqual(restored.unreadable, []);
		assert.equal(restored.position!.nodes[0].title, '周伯收信');
		assert.deepEqual(await readFile(buoyFile), before);
		await rm(join(f.book, mirror));
		await f.index.refresh(mirror);
		const deleted = await f.buoys.read(chapter);
		assert.deepEqual(deleted.unreadable, []);
		assert.equal(deleted.lost, true);
		f.answer('1');
		f.buoys.update(deleted, '文'.repeat(2000));
		await f.buoys.drain();
		assert.equal(f.requests.length, 1);
		assert.equal((await f.marks()).marks.at(-1).by, 'relocate');
	});
}

test('position relocation reads prefaced raw replies through the final numbered chunk', async (t) => {
	const f = await fixture(t);
	let prefix = '';
	t.mock.method(
		globalThis,
		'fetch',
		async () => new Response(openaiText(prefix) + openaiText('1') + openaiUsage({ prompt_tokens: 10, completion_tokens: 2 }) + OPENAI_END),
	);
	const buoys = new Buoys(f.index, f.settings, f.usage, () => undefined);
	for (prefix of ['以下是', '根据你的', '输出：']) {
		await buoys.act(chapter, 'relocate');
		const current = await buoys.read(chapter);
		assert.equal(current.position!.nodes[0].id, current.graph.leaves[0].id);
		assert.equal(current.file!.marks.at(-1)!.by, 'relocate');
	}
	assert.equal(f.usage.today().requests, 3);
	await buoys.dispose();
});

test('disposing aborted position requests waits for accounting and releases the usage lock', async (t) => {
	const f = await fixture(t);
	await f.usage.add('continuation', { input: 10, output: 2 }, 0);
	let signal!: AbortSignal;
	let started!: () => void;
	const begun = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		signal = init.signal!;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(openaiText('以下是')));
					signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
					started();
				},
			}),
		);
	});
	let writing!: () => void;
	const writeStarted = new Promise<void>((resolve) => {
		writing = resolve;
	});
	let release!: () => void;
	const writeAllowed = new Promise<void>((resolve) => {
		release = resolve;
	});
	const write = fs.writeFile;
	t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
		if (String(args[0]) === join(f.root, 'usage/usage.json')) {
			writing();
			await writeAllowed;
		}
		return write(...args);
	});
	const buoy = new Buoys(f.index, f.settings, f.usage, () => undefined);
	const before = await readFile(join(f.book, buoyPath(chapter)));
	buoy.update(await buoy.read(chapter), '文'.repeat(2000));
	await begun;
	let closed = false;
	const closing = buoy.dispose().then(() => {
		closed = true;
	});
	assert.equal(signal.aborted, true);
	await writeStarted;
	assert.equal(closed, false);
	assert.ok((await readdir(join(f.root, 'usage'))).includes('usage.lock'));
	release();
	await closing;
	const ledger = new UsageStore(join(f.root, 'usage'));
	await ledger.load();
	assert.equal(ledger.today().requests, 2);
	assert.equal(ledger.today().unknown, 1);
	assert.ok(JSON.stringify(ledger.current()).includes('position'));
	assert.equal((await readdir(join(f.root, 'usage'))).includes('usage.lock'), false);
	assert.deepEqual(await readFile(join(f.book, buoyPath(chapter))), before);
});

test('a position request aborted before response headers records one unpriced request', async (t) => {
	const f = await fixture(t);
	let started!: () => void;
	const begun = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(
		globalThis,
		'fetch',
		(_url: unknown, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
				started();
			}),
	);
	const buoy = new Buoys(f.index, f.settings, f.usage, () => undefined);
	buoy.update(await buoy.read(chapter), '文'.repeat(2000));
	await begun;
	await buoy.dispose();
	const ledger = new UsageStore(join(f.root, 'usage'));
	await ledger.load();
	assert.equal(ledger.today().requests, 1);
	assert.equal(ledger.today().unknown, 1);
	assert.ok(JSON.stringify(ledger.current()).includes('position'));
});
