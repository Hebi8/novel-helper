// The extension as a whole, activated against the stand-in for `vscode` in a
// real temporary folder: what the sidebar's commands do to the files, what
// is left alone, and what the writer is told.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { MARKER_FILE, serializeMarker } from '../core/story';
import { fakeServer, OPENAI_END, OPENAI_START, openaiText, stream } from './fakeServer';
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
