// The extension as a whole, activated against the stand-in for `vscode` in a
// real temporary folder: what the sidebar's commands do to the files, what
// is left alone, and what the writer is told.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { type BuoyFile, type BuoyState, buoyPath, serializeBuoyFile } from '../core/buoy';
import { MARKER_FILE, serializeMarker } from '../core/story';
import { fakeServer, type FakeServer, OPENAI_END, OPENAI_START, openaiText, sleep, stream } from './fakeServer';
import { filesIn, start, type Started } from './vscodeStub';

const MARKER = serializeMarker({ version: 1, language: 'zh' });
const started: Started[] = [];
after(() => started.forEach((one) => one.dispose()));

/** A workspace with these files (path → content), relative to the workspace folder, and the extension activated in it. */
async function workspace(files: Record<string, string>, settings: Record<string, unknown> = {}): Promise<Started> {
	const one = await start((folder) => {
		for (const [file, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
			fs.writeFileSync(path.join(folder, file), content);
		}
	}, settings);
	started.push(one);
	return one;
}

const empty = (...files: string[]) => Object.fromEntries(files.map((file) => [file, '']));
/** Everything below the folder the workspace is in, the extension's own storage aside. */
const everything = (one: Started) => filesIn(one.base).filter((file) => !file.startsWith('storage/'));
/** The only book of the book view. */
const book = async (one: Started) => (await one.trees['novelHelper.book'].getChildren())[0];
/** The item of the book tree at these names below `item`. */
const child = (item: any, ...names: string[]) =>
		names.reduce((parent, name) => ({ index: parent.index, node: parent.node.children.find((node: any) => node.name === name), parent }), item);
const rename = async (one: Started, item: unknown, name: string) => {
	one.answers.push(() => name);
	await one.commands['novelHelper.book.rename'](item);
	await one.settle();
};

describe('renaming in the book tree', () => {
	test('same-named arcs of two volumes whose outlines are in one folder: nothing is moved, and the writer is told which folder', async () => {
		const one = await workspace(empty('正文/卷一/第一幕/第1章.md', '正文/卷二/第一幕/第9章.md', '大纲/第一幕/第1章.md', '大纲/第一幕/第9章.md'));
		const before = one.files();
		await rename(one, child(await book(one), '卷一', '第一幕'), '序幕');
		assert.deepEqual(one.files(), before);
		assert.equal(one.messages.length, 1);
		assert.match(one.messages[0], /^第一幕 was not renamed, and nothing was changed: 大纲\/第一幕 is shared by 正文\/卷一\/第一幕, 正文\/卷二\/第一幕/);
		// The volumes share nothing: they can be renamed as before.
		await rename(one, child(await book(one), '卷一'), '第一卷');
		assert.deepEqual(one.files(), ['大纲/第一幕/第1章.md', '大纲/第一幕/第9章.md', '正文/卷二/第一幕/第9章.md', '正文/第一卷/第一幕/第1章.md']);
	});

	test('an outline that two chapters take: nothing is moved', async () => {
		const one = await workspace(empty('正文/卷一/第1章.md', '正文/卷二/第1章.md', '大纲/第1章.md'));
		const before = one.files();
		await rename(one, child(await book(one), '卷一', '第1章'), '第1章 雾');
		assert.deepEqual(one.files(), before);
		assert.match(one.messages[0], /nothing was changed: 大纲\/第1章\.md is shared by 正文\/卷一\/第1章\.md, 正文\/卷二\/第1章\.md/);
	});

	test('a level named like the one it is in: every step of the rename can be done, none is left half-way', async () => {
		const one = await workspace(empty('正文/A/A/第1章.md', '大纲/A/A.md'));
		await rename(one, child(await book(one), 'A', 'A'), 'B');
		assert.deepEqual(one.files(), ['大纲/A/B.md', '正文/A/B/第1章.md']);
		assert.deepEqual(one.messages, []);
		assert.deepEqual(await one.labels('novelHelper.book'), [(await one.labels('novelHelper.book'))[0], '  A', '    B', '      第1章']);
	});

	test('a volume with its own outlines and summaries: all of it goes along', async () => {
		const one = await workspace(
			empty('正文/卷一/第1章.md', '正文/卷二/第2章.md', '大纲/卷一.md', '大纲/卷一/第1章.md', '摘要/卷一/第1章.md', '大纲/卷二/第2章.md'),
		);
		await rename(one, child(await book(one), '卷一'), '第一卷');
		assert.deepEqual(one.files(), ['大纲/卷二/第2章.md', '大纲/第一卷/第1章.md', '大纲/第一卷.md', '摘要/第一卷/第1章.md', '正文/卷二/第2章.md', '正文/第一卷/第1章.md']);
		await rename(one, child(await book(one), '第一卷', '第1章'), '第1章 雾');
		assert.deepEqual(one.files(), ['大纲/卷二/第2章.md', '大纲/第一卷/第1章 雾.md', '大纲/第一卷.md', '摘要/第一卷/第1章 雾.md', '正文/卷二/第2章.md', '正文/第一卷/第1章 雾.md']);
		assert.deepEqual(one.messages, []);
	});
});

describe('settings that name places outside the story folder', () => {
	const init = async (one: Started) => {
		// Where: the workspace folder itself. Names: the first choice. Then everything that is ticked.
		one.answers.push(
			() => '',
			(items) => items[0],
			(items) => items.filter((item: { picked?: boolean }) => item.picked),
		);
		await one.commands['novelHelper.init']();
		await one.settle();
	};

	test('initializing makes nothing when a name of the book leads out', async () => {
		const one = await workspace({}, { 'novelHelper.files.bookNames': ['../../escaped-book'] });
		await init(one);
		assert.deepEqual(everything(one), []);
		assert.match(one.messages[0], /^Nothing was changed: .*escaped-book\.md would be outside the story folder/);
	});

	test('initializing makes nothing when a lore folder leads out', async () => {
		const one = await workspace({}, { 'novelHelper.files.lore': ['../escaped/**/*.md'] });
		await init(one);
		assert.deepEqual(everything(one), []);
		assert.match(one.messages[0], /^Nothing was changed: \.\.\/escaped/);
	});

	test('with the settings as they come, initializing makes the story and its marker', async () => {
		const one = await workspace({});
		await init(one);
		// The display language of the stand-in is English, so the English names come first.
		assert.deepEqual(one.files(), [MARKER_FILE, 'lore/Style.md', 'outlines/book.md']);
		assert.deepEqual(one.messages, []);
		assert.deepEqual(everything(one), one.files().map((file) => `workspace/${file}`));
	});

	test('the outline of the book, a new lore entry, a new chapter: none is made outside', async () => {
		const one = await workspace(empty('正文/第1章.md'), {
			'novelHelper.files.bookNames': ['../../escaped-book'],
			'novelHelper.files.lore': ['../escaped/**/*.md'],
		});
		await one.commands['novelHelper.book.openOutline']();
		// The type, then the name.
		one.answers.push(
			() => '人物',
			() => '甲',
		);
		await one.commands['novelHelper.lore.new']();
		await one.settle();
		assert.deepEqual(everything(one), ['workspace/正文/第1章.md']);
		assert.equal(one.messages.length, 2);
		assert.ok(one.messages.every((message) => message.startsWith('Nothing was changed: ')));

		const bare = await workspace({}, { 'novelHelper.files.chapters': ['../chapters/**/*.md'] });
		bare.answers.push(() => '第1章');
		await bare.commands['novelHelper.book.newChapter']();
		await bare.settle();
		assert.deepEqual(everything(bare), []);
		assert.deepEqual(bare.messages.map((message) => message.slice(0, 40)), ['Nothing was changed: ../chapters/第1章.md ']);
	});

	test('a lore type is not followed out of the templates folder', async () => {
		const one = await start((folder, base) => {
			fs.mkdirSync(path.join(folder, '设定'));
			fs.writeFileSync(path.join(base, 'private.md'), 'not for the story');
		});
		started.push(one);
		one.answers.push(
			() => '../../../private',
			() => '甲',
		);
		await one.commands['novelHelper.lore.new']();
		await one.settle();
		assert.ok(!one.reads.some((file) => file.includes('private')), one.reads.join('\n'));
		assert.deepEqual(one.files(), ['设定/甲.md']);
		assert.ok(!one.read('设定/甲.md').includes('not for the story'));
		assert.match(one.read('设定/甲.md'), /^---\ntype: "?\.\.\/\.\.\/\.\.\/private"?\n/);
	});

	test('a template of the story folder is still used, and a name is filled in as a YAML value', async () => {
		const one = await workspace({ '设定/人物/乙.md': '---\ntype: 人物\n---\n', '.novel-helper/templates/人物.md': '---\nname: {{name}}\ntype: 人物\n---\n\n# {{name}}\n' });
		one.answers.push(() => '风: $& 雨');
		await one.commands['novelHelper.lore.new']({ index: (await book(one)).index, type: '人物' });
		await one.settle();
		assert.equal(one.read('设定/人物/风: $& 雨.md'), '---\nname: "风: $& 雨"\ntype: 人物\n---\n\n# 风: $& 雨\n');
	});
});

describe('frontmatter fields set from the lore view', () => {
	test('a field that cannot be set without rewriting what is around it: the file is left as it is', async () => {
		const flow = '---\n{type: 人物, always: false} # 主角\n---\n\n正文。\n';
		const commented = '---\ntype: 人物\naliases: # 角色别称\n  - 阿青\n---\n';
		const one = await workspace({ '设定/青.md': flow, '设定/白.md': commented });
		const entry = (name: string) => one.find('novelHelper.lore', '人物', name);
		one.answers.push(() => '阿青, 小青');
		await one.commands['novelHelper.lore.setAliases'](await entry('青'));
		one.answers.push(() => '小白');
		await one.commands['novelHelper.lore.setAliases'](await entry('白'));
		await one.settle();
		assert.equal(one.read('设定/青.md'), flow);
		assert.equal(one.read('设定/白.md'), commented);
		assert.equal(one.messages.length, 2);
		assert.match(one.messages[0], /^设定\/青\.md was not changed: /);
		// What is there can be changed in place, comment and all.
		await one.commands['novelHelper.lore.pin'](await entry('青'));
		await one.settle();
		assert.equal(one.read('设定/青.md'), flow.replace('false', 'true'));
		assert.equal(one.messages.length, 2);
	});
});

describe('the story folder', () => {
	const story = async (one: Started) => (await one.trees['novelHelper.settings'].getTreeItem(await one.find('novelHelper.settings', 'Story folder'))).description as string;

	test('going back to the workspace folder writes the empty path, so that a setting from further up does not come back', async () => {
		const one = await workspace(empty('books/one/正文/第1章.md', '正文/第1章.md'), { 'novelHelper.files.storyFolder': 'books/one' });
		one.answers.push((items) => items.find((item: { label: string }) => item.label.includes('Back to the workspace folder')));
		await one.commands['novelHelper.selectStoryFolder']();
		assert.deepEqual(one.updates, [['novelHelper.files.storyFolder', '']]);
	});

	test('a workspace in use without a marker is "in use"; a marker made or removed outside VS Code shows without a reload', async () => {
		const one = await workspace(empty('正文/第1章.md'));
		assert.match(await story(one), / · in use$/);
		one.write(MARKER_FILE, MARKER);
		one.changedOutside('create', MARKER_FILE);
		await one.settle();
		assert.match(await story(one), / · initialized$/);
		fs.rmSync(path.join(one.workspace, MARKER_FILE));
		one.changedOutside('delete', MARKER_FILE);
		await one.settle();
		assert.match(await story(one), / · in use$/);
	});

	test('markers in build output and deep down do not crowd out a story folder that counts', async () => {
		const one = await start((folder) => {
			const mark = (dir: string) => {
				fs.mkdirSync(path.join(folder, dir, path.dirname(MARKER_FILE)), { recursive: true });
				fs.writeFileSync(path.join(folder, dir, MARKER_FILE), MARKER);
			};
			for (let i = 0; i < 260; i++) {
				mark(`build/copy${i}`);
			}
			for (let i = 0; i < 30; i++) {
				mark(`a/b/c/d/e/deep${i}`);
			}
			mark('zz/story');
		});
		started.push(one);
		assert.deepEqual(await one.labels('novelHelper.book'), ['zz/story', 'Initialize a story folder…']);
	});

	test('an index dropped while it was still loading starts no watchers', async () => {
		const one = await workspace(empty('正文/第1章.md'));
		const watching = one.watchers();
		const files = one.vscode.workspace.getConfiguration('novelHelper.files');
		const release = one.holdStat();
		// The settings change twice while the folder is being looked at: the first index is dropped before it has scanned.
		await files.update('bookNames', ['全书']);
		await one.settle();
		await files.update('bookNames', ['全书', '总纲']);
		await one.settle();
		release();
		await one.settle();
		assert.equal(one.watchers(), watching);
		one.dispose();
		assert.equal(one.watchers(), 0);
	});
});

describe('ghost text', () => {
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
	const suggest = async (one: Started) => {
		const document = await one.vscode.workspace.openTextDocument(one.vscode.Uri.file(path.join(one.workspace, '正文/第1章.md')));
		return one.providers.inline.provideInlineCompletionItems(document, document.positionAt(document.getText().length), { triggerKind: 1 }, token);
	};
	const setup = async (reply = '灯还亮着。', chapter = '雾从海上来。\n') => {
		const server = await fakeServer((res) => stream(res, [OPENAI_START, openaiText(reply), OPENAI_END]));
		const one = await workspace(
			{ '正文/第1章.md': chapter },
			{ 'novelHelper.provider': 'openaiCompatible', 'novelHelper.openaiCompatible.baseUrl': server.baseUrl, 'novelHelper.openaiCompatible.model': 'local', 'novelHelper.debounceMs': 0 },
		);
		return { server, one, lock: path.join(one.storage, 'usage.lock') };
	};

	test('switched off while waiting for the usage file that another window holds: no request is sent', async () => {
		const { server, one, lock } = await setup();
		try {
			fs.writeFileSync(lock, 'another window');
			const pending = suggest(one);
			await one.settle();
			await one.vscode.workspace.getConfiguration('novelHelper').update('enabled', false);
			fs.rmSync(lock);
			assert.equal(await pending, undefined);
			assert.equal(server.received.length, 0);
		} finally {
			await server.close();
		}
	});

	test('left on, the same wait ends in a request and a suggestion', async () => {
		const { server, one, lock } = await setup();
		try {
			fs.writeFileSync(lock, 'another window');
			const pending = suggest(one);
			await one.settle();
			fs.rmSync(lock);
			assert.equal((await pending)[0].insertText, '灯还亮着。');
			assert.equal(server.received.length, 1);
		} finally {
			await server.close();
		}
	});

	test('several paragraphs come as one insertion at the cursor, written the way the chapter writes them; the request asks for the length set', async () => {
		const { server, one } = await setup('\n\n灯还亮着。\n\n她推开门，屋里没有人。', '　　雾从海上来。\n　　潮声很远。');
		try {
			const [item] = await suggest(one);
			assert.equal(item.insertText, '\n　　灯还亮着。\n　　她推开门，屋里没有人。');
			assert.deepEqual([item.range.start, item.range.end].map((at) => [at.line, at.character]), [[1, 7], [1, 7]], 'nothing is replaced');
			const { body } = server.received[0];
			assert.equal(body.max_tokens, 200);
			assert.match((body.messages as Array<{ content: string }>)[1].content, /最多 100 个字。$/);
		} finally {
			await server.close();
		}
	});
});

describe('position on the outline', () => {
	const OUTLINE = {
		'大纲/全书.md': '全书的概述',
		'大纲/第1章.md': '## 来信\n\n信送不出去。\n→ 没有的节点\n\n## 等门\n\n等到傍晚。\n',
		'大纲/第2章.md': '## 收信\n\n周伯收下信。\n',
	};
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
	const servers: FakeServer[] = [];
	after(() => Promise.all(servers.map((server) => server.close())));

	/** A workspace with the outline above and these chapters, and a model that gives `answers` in turn to the questions about the position. */
	const setup = async (chapters: Record<string, string>, answers: string[] = [], files: Record<string, string> = {}, settings: Record<string, unknown> = {}) => {
		const asked: string[] = [];
		const prompts: string[] = [];
		let held: Promise<void> | undefined;
		const server = await fakeServer(async (res, request) => {
			const [system, user] = (request.body.messages as Array<{ content: string }>).map((message) => message.content);
			const position = system.startsWith('你在帮一位小说作者');
			(position ? asked : prompts).push(user);
			if (position) {
				await held;
			}
			return stream(res, [OPENAI_START, openaiText(position ? (answers.shift() ?? '') : '灯还亮着。'), OPENAI_END]);
		});
		/** Makes the model take its time over the questions about the position, until the returned function is called. */
		const holdAnswers = () => {
			let release!: () => void;
			held = new Promise((resolve) => (release = resolve));
			return () => {
				held = undefined;
				release();
			};
		};
		servers.push(server);
		const one = await workspace(
			{ ...OUTLINE, ...files, ...Object.fromEntries(Object.entries(chapters).map(([name, text]) => [`正文/${name}.md`, text])) },
			{ 'novelHelper.provider': 'openaiCompatible', 'novelHelper.openaiCompatible.baseUrl': server.baseUrl, 'novelHelper.openaiCompatible.model': 'local', 'novelHelper.debounceMs': 0, ...settings },
		);
		const open = (chapter: string) => one.vscode.window.showTextDocument(one.vscode.Uri.file(path.join(one.workspace, `正文/${chapter}.md`)));
		const suggest = async (chapter: string) => {
			await open(chapter);
			const { document } = one.vscode.window.activeTextEditor;
			await one.providers.inline.provideInlineCompletionItems(document, document.positionAt(document.getText().length), { triggerKind: 1 }, token);
			await one.settle();
		};
		const marks = (chapter: string) =>
			(JSON.parse(one.read(buoyPath(`正文/${chapter}.md`))) as BuoyFile).marks.map((mark) => `${mark.by} ${mark.state.kind}: ${mark.state.nodes.map((node) => node.title).join(', ')}`);
		const node = (...titles: string[]) => one.find('novelHelper.outline', '全书', ...titles);
		return { one, asked, prompts, open, suggest, marks, node, holdAnswers };
	};
	const state = (kind: BuoyState['kind'], ...ids: string[]): BuoyState => ({ kind, nodes: ids.map((id) => ({ id, title: id.slice(id.lastIndexOf('#') + 1) })) });
	/** A buoy file whose only mark was made when the chapter had `chars` characters. */
	const marked = (chapter: string, chars: number, at: BuoyState) =>
		({ [buoyPath(`正文/${chapter}.md`)]: serializeBuoyFile({ version: 1, chapter: `正文/${chapter}.md`, marks: [{ at: chars, before: '', chars, time: '2026-11-12T00:00:00.000Z', by: 'manual', state: at }] }) });
	const long = (chars: number) => '他等了很久。'.repeat(Math.ceil(chars / 6)).slice(0, chars);

	test('a chapter that is starting is put on the outline without asking the model, and the prompt says where it is', async () => {
		const { one, asked, prompts, suggest, marks } = await setup({ 第1章: '', 第2章: '' });
		await suggest('第1章');
		assert.deepEqual(marks('第1章'), ['init in: 来信'], 'the first leaf of the outline file of its name');
		assert.match(prompts[0], /<上层大纲>\n【全书】\n全书的概述\n<\/上层大纲>\n\n<当前位置>\n正文现在写到【来信】。\n\n【来信】\n信送不出去。\n\n接下来是：\n【等门】\n等到傍晚。\n<\/当前位置>/);
		assert.doesNotMatch(prompts[0], /<本章大纲>/);
		await one.commands['novelHelper.position.forward']();
		await suggest('第2章');
		assert.deepEqual(marks('第2章'), ['init in: 等门'], 'where the chapter before it ended');
		assert.deepEqual(asked, []);
		assert.ok(one.files().includes('.novel-helper/buoys/正文/第1章.md.json'));
	});

	test('grown by the update length: the model is asked in the background whether it moved, and the answer is marked', async () => {
		const text = long(1200);
		const { one, asked, prompts, suggest, marks } = await setup({ 第1章: text }, ['3', '乱答'], marked('第1章', 150, state('in', '大纲/第1章.md#来信')));
		await suggest('第1章');
		assert.equal(asked.length, 1);
		assert.match(prompts[0], /正文现在写到【来信】。/, 'the continuation goes out with the position as it was');
		assert.match(asked[0], /<当前位置>\n正文现在写到【来信】。\n<\/当前位置>/);
		assert.match(asked[0], /<最近的正文>\n他等了很久。/, 'from a little before the last mark; here that is the start');
		assert.match(asked[0], /1\. 还在【来信】里\n2\. 【来信】的内容基本写完了，正在写它和【等门】之间的衔接\n3\. 已经在写【等门】的内容\n\n只回答一个编号。$/);
		assert.deepEqual(marks('第1章'), ['manual in: 来信', 'auto in: 等门']);
		const last = (JSON.parse(one.read(buoyPath('正文/第1章.md'))) as BuoyFile).marks[1];
		assert.deepEqual([last.at, last.chars, last.before], [1200, 1200, text.slice(-30)]);
		const ledger = JSON.parse(fs.readFileSync(path.join(one.storage, 'usage.json'), 'utf8')) as Record<string, Record<string, { requests: number }>>;
		assert.deepEqual(Object.fromEntries(Object.entries(Object.values(ledger)[0]).map(([key, totals]) => [key, totals.requests])), { 'openaiCompatible/local': 1, 'openaiCompatible/local#position': 1 });

		await suggest('第1章');
		assert.equal(asked.length, 1, 'not asked again until the chapter has grown again');
		one.vscode.window.activeTextEditor.document.content = long(2300);
		await suggest('第1章');
		assert.equal(asked.length, 2);
		assert.match(asked[1], /<最近的正文>\n（前略）/);
		assert.deepEqual(marks('第1章').slice(2), ['auto in: 等门'], 'an answer that cannot be read moves nothing, and is marked so');
	});

	test('a chapter with text and no position: the model searches the whole outline; an answer that names no node is not asked for again at once', async () => {
		const { asked, prompts, suggest, marks, one } = await setup({ 第1章: long(400), 第2章: long(400) }, ['3', '没有这样的节点']);
		await suggest('第2章');
		assert.match(asked[0], /^<大纲节点>\n1\. 第1章 › 来信：信送不出去。\n2\. 第1章 › 等门：等到傍晚。\n3\. 第2章 › 收信：周伯收下信。\n<\/大纲节点>\n\n<本章正文 文件="第2章">\n他等了很久。/);
		assert.match(prompts[0], /<本章大纲>\n## 收信/, 'until it is found, the chapter goes by the outline file of its name');
		assert.deepEqual(marks('第2章'), ['relocate in: 收信']);
		await suggest('第2章');
		assert.match(prompts[1], /<当前位置>\n正文现在写到【收信】。\n\n【收信】\n周伯收下信。\n<\/当前位置>/, 'the last leaf: nothing comes next');

		await suggest('第1章');
		await suggest('第1章');
		assert.equal(asked.length, 2, 'asked once');
		assert.ok(!one.files().includes('.novel-helper/buoys/正文/第1章.md.json'));
	});

	test('with the update length at 0 the model is never asked; a chapter that is starting is still placed', async () => {
		const { asked, suggest, marks, one } = await setup({ 第1章: '', 第2章: long(1500) }, [], {}, { 'novelHelper.position.updateChars': 0 });
		await suggest('第1章');
		await suggest('第2章');
		assert.deepEqual(marks('第1章'), ['init in: 来信']);
		assert.ok(!one.files().includes('.novel-helper/buoys/正文/第2章.md.json'));
		assert.deepEqual(asked, []);
	});

	test('the outline view shows the nodes, the links that lead nowhere, and where the chapter is; the buoys are moved from it and by command', async () => {
		const { one, open, marks, node } = await setup({ 第1章: long(300) });
		assert.deepEqual(await one.labels('novelHelper.outline'), ['全书', '  第1章', '    来信', '    等门', '  第2章', '    收信']);
		const item = async (...titles: string[]) => one.trees['novelHelper.outline'].getTreeItem(await node(...titles));
		assert.equal((await item('第1章', '来信')).description, '→ 没有的节点: no such node');
		assert.deepEqual((await item('第1章', '等门')).command.arguments.map((argument: any) => argument.path ?? argument.selection.start.line), [path.join(one.workspace, '大纲/第1章.md'), 5]);

		await one.commands['novelHelper.position.forward']();
		assert.match(one.messages.at(-1)!, /^Open a chapter first/);
		await open('第1章');
		await one.settle();
		assert.equal(one.views['novelHelper.outline'].message, '第1章: no position on the outline yet');
		await one.commands['novelHelper.outline.placeHere'](await node('第1章'));
		await one.settle();
		assert.equal((await item('第1章', '来信')).description, '◉ the chapter is here · → 没有的节点: no such node');
		assert.equal(one.views['novelHelper.outline'].message, '第1章: in 【来信】');
		assert.match(one.statusItem.tooltip, /\n\n第1章 on the outline: in 【来信】\n\n/);

		// The outline file has the focus now: the commands still mean the chapter.
		await one.vscode.window.showTextDocument(one.vscode.Uri.file(path.join(one.workspace, '大纲/第1章.md')));
		await one.commands['novelHelper.outline.bridgeTo'](await node('第2章', '收信'));
		assert.deepEqual([(await item('第1章', '来信')).description.split(' · ')[0], (await item('第2章', '收信')).description], ['◉ the chapter is leaving here', '→ the chapter is heading here']);
		assert.equal((await item('第2章', '收信')).contextValue, 'outlineSecond');
		await one.commands['novelHelper.outline.addParallel'](await node('第1章', '等门'));
		await one.commands['novelHelper.outline.dropSecond']();
		await one.commands['novelHelper.position.forward']();
		await one.commands['novelHelper.position.forward']();
		await one.commands['novelHelper.position.forward']();
		assert.match(one.messages.at(-1)!, /last node of the outline/);
		await one.commands['novelHelper.position.back']();
		assert.deepEqual(marks('第1章'), ['manual in: 来信', 'manual bridge: 来信, 收信', 'manual parallel: 来信, 等门', 'manual in: 来信', 'manual in: 等门', 'manual in: 收信', 'manual in: 等门']);
	});

	test('"Let the Model Find the Position" asks at once and says what came of it', async () => {
		const { one, open, asked, marks } = await setup({ 第1章: long(50) }, ['2', '？']);
		await open('第1章');
		await one.commands['novelHelper.position.relocate']();
		assert.equal(asked.length, 1);
		assert.deepEqual(marks('第1章'), ['relocate in: 等门']);
		assert.equal(one.messages.at(-1), '第1章 is in 【等门】.');
		await one.commands['novelHelper.position.relocate']();
		assert.match(one.messages.at(-1)!, /did not name a node of the outline/);
		assert.deepEqual(marks('第1章'), ['relocate in: 等门']);
	});

	test('renaming a chapter in the sidebar takes its buoys along, and the buoys of every chapter follow the outline file renamed with it', async () => {
		const { one, marks } = await setup(
			{ 第1章: '', 第2章: '' },
			[],
			{ ...marked('第1章', 0, state('in', '大纲/第1章.md#等门')), ...marked('第2章', 0, state('bridge', '大纲/第1章.md#等门', '大纲/第2章.md#收信')) },
		);
		await rename(one, child(await book(one), '第1章'), '第1章 来信');
		await one.settle();
		const files = one.files().filter((file) => file.startsWith('.novel-helper/'));
		assert.deepEqual(files, ['.novel-helper/buoys/正文/第1章 来信.md.json', '.novel-helper/buoys/正文/第2章.md.json']);
		const moved = JSON.parse(one.read(files[0])) as BuoyFile;
		assert.deepEqual([moved.chapter, moved.marks[0].state.nodes[0].id], ['正文/第1章 来信.md', '大纲/第1章 来信.md#等门']);
		assert.deepEqual((JSON.parse(one.read(files[1])) as BuoyFile).marks[0].state.nodes.map((ref) => ref.id), ['大纲/第1章 来信.md#等门', '大纲/第2章.md#收信']);
		assert.deepEqual(marks('第2章'), ['manual bridge: 等门, 收信']);
	});

	test('an answer about the position that comes after files were renamed is dropped: the marks as the rename left them stand', async () => {
		const { one, asked, suggest, holdAnswers } = await setup({ 第1章: '', 第2章: long(1200) }, ['3', '3'], marked('第2章', 0, state('in', '大纲/第1章.md#来信')));
		const written = () => (JSON.parse(one.read(buoyPath('正文/第2章.md'))) as BuoyFile).marks.map((mark) => `${mark.by} ${mark.state.nodes[0].id}`);
		const answer = holdAnswers();
		await suggest('第2章');
		assert.equal(asked.length, 1, 'the model is being asked');
		await rename(one, child(await book(one), '第1章'), '第1章 来信');
		await one.settle();
		assert.deepEqual(written(), ['manual 大纲/第1章 来信.md#来信']);
		answer();
		await one.settle();
		assert.deepEqual(written(), ['manual 大纲/第1章 来信.md#来信'], 'the answer was about the outline as it was');
		// The next request asks again, about the outline as it is now.
		await suggest('第2章');
		assert.equal(asked.length, 2);
		assert.deepEqual(written(), ['manual 大纲/第1章 来信.md#来信', 'auto 大纲/第1章 来信.md#等门']);
	});

	test('a buoy file is the file of the chapter at its path, whatever chapter it names inside: nothing is written where that points', async () => {
		const file = serializeBuoyFile({ ...(JSON.parse(Object.values(marked('第1章', 300, state('in', '大纲/第1章.md#来信')))[0]) as BuoyFile), chapter: '../../../outside' });
		const { one, open, marks } = await setup({ 第1章: long(300) }, [], { [buoyPath('正文/第1章.md')]: file });
		await open('第1章');
		await one.settle();
		await one.commands['novelHelper.position.forward']();
		await one.settle();
		assert.equal(fs.existsSync(path.join(one.base, 'outside.json')), false);
		assert.deepEqual(marks('第1章'), ['manual in: 来信', 'manual in: 等门']);
		assert.equal((JSON.parse(one.read(buoyPath('正文/第1章.md'))) as BuoyFile).chapter, '正文/第1章.md');
	});

	test('a mark the writer adds while a mark of the assistant is being filled in is kept', async () => {
		const open = JSON.stringify({ version: 1, chapter: '正文/第1章.md', marks: [{ by: 'assistant', state: state('in', '大纲/第1章.md#来信') }] });
		const { one, open: show, marks } = await setup({ 第1章: long(300) }, [], { [buoyPath('正文/第1章.md')]: open });
		// The first time the file is written back with the mark made whole, the disk is slow.
		const files = one.vscode.workspace.fs;
		const writeFile = files.writeFile;
		let waiting = false;
		let release!: () => void;
		const slow = new Promise<void>((resolve) => (release = resolve));
		files.writeFile = async (uri: { path: string }, content: Uint8Array) => {
			if (!waiting && uri.path.endsWith('.md.json')) {
				waiting = true;
				await slow;
			}
			return writeFile(uri, content);
		};
		await show('第1章');
		while (!waiting) {
			await sleep(10);
		}
		const moving = one.commands['novelHelper.position.forward']();
		await sleep(150);
		release();
		await moving;
		await one.settle();
		assert.deepEqual(marks('第1章'), ['assistant in: 来信', 'manual in: 等门']);
	});

	test('a heading renamed in the outline: the buoys are lost, said so, and searched for again', async () => {
		const { one, open, asked, suggest, marks } = await setup({ 第1章: long(300) }, ['2'], marked('第1章', 300, state('in', '大纲/第1章.md#等门')));
		one.write('大纲/第1章.md', '## 来信\n\n## 等到傍晚\n');
		one.changedOutside('change', '大纲/第1章.md');
		await open('第1章');
		await one.settle();
		assert.equal(one.views['novelHelper.outline'].message, '第1章: lost: 【等门】 is no longer in the outline');
		await suggest('第1章');
		assert.equal(asked.length, 1);
		assert.deepEqual(marks('第1章'), ['manual in: 等门', 'relocate in: 等到傍晚']);
	});
});
