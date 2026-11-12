// What the assistant is told, which of its requests go through unasked, and
// how its stream of updates becomes the panel's list.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { editorContextBlock, editorContextLabel, MAX_SELECTION_CHARS, workspaceBrief } from '../core/assistantBrief';
import { hasOpenMarks, markAt, parseBuoyFile, resolve } from '../core/buoy';
import { buildOutline } from '../core/outline';
import { allowOnce, decide, locate, pathsOf } from '../core/permission';
import type { StoryNames } from '../core/scaffold';
import { type Item, Transcript } from '../core/transcript';
import type { SessionUpdate } from '../acp/client';

const ZH: StoryNames = { language: 'zh', chapters: '正文', outlines: '大纲', summaries: '摘要', lore: ['设定', '人物', '资料'], book: '全书' };
const EN: StoryNames = { language: 'en', chapters: 'manuscript', outlines: 'outlines', summaries: 'summaries', lore: ['lore'], book: 'book' };

describe('the brief on the workspace', () => {
	test('in Chinese, with the folders the story uses', () => {
		const brief = workspaceBrief(ZH);
		for (const part of [
			'`正文/`：章节',
			'`正文/第一卷/第3章.md` → `大纲/第一卷/第3章.md`',
			'`正文/第一卷/` → `大纲/第一卷.md`',
			'全书大纲是 `大纲/全书.md`',
			'`摘要/`：章节摘要',
			'`设定/`、`人物/`、`资料/`：设定条目',
			'`always: true`',
			'`aliases`',
			'包括正文，也包括 `.novel-helper/` 里快照以外的文件，不用逐个问',
			'默认不放行',
			'`.novel-helper/snapshots/` 是快照，不要动',
			'## 大纲图和浮标',
			'`正文/第一卷/第3章.md` → `.novel-helper/buoys/正文/第一卷/第3章.md.json`',
			'不要写 `at`、`before`、`chars`、`time`',
			'`{ "version": 1, "chapter": "正文/第一卷/第3章.md", "marks": [ … ] }`',
			'你改了大纲的标题或结构的时候',
			'`<editor-context>`',
		]) {
			assert.ok(brief.includes(part), part);
		}
		assert.doesNotMatch(brief, /chapters|outlines\//);
	});

	test('other names: the brief follows them, also the book outline\'s', () => {
		const brief = workspaceBrief({ ...ZH, chapters: '章节', outlines: '细纲', lore: ['世界观'], book: '总纲' });
		assert.ok(brief.includes('`章节/第一卷/第3章.md` → `细纲/第一卷/第3章.md`'));
		assert.ok(brief.includes('全书大纲是 `细纲/总纲.md`'));
		assert.ok(brief.includes('- `世界观/`：设定条目'));
		assert.doesNotMatch(brief, /正文\/|大纲\//);
	});

	test('the buoys: the ids the brief gives are the ids of the graph, and the mark it shows is one the extension takes', () => {
		for (const names of [ZH, EN]) {
			const zh = names.language === 'zh';
			const brief = workspaceBrief(names);
			const [volume, chapter, heading, below] = zh ? ['第一卷', '第3章', '渡海', '上船'] : ['Volume 1', 'Chapter 3', 'The crossing', 'Boarding'];
			const file = `${names.outlines}/${volume}/${chapter}.md`;
			const outline = (content: string) => buildOutline([{ path: file, dirs: [volume], content }], { name: names.book });
			const graph = outline(`# ${chapter}\n\n## ${heading}\n\n## ${heading}\n`);
			const deeper = outline(`## ${heading}\n\n### ${below}\n`);
			// Every id the brief shows is in a graph of files so named.
			for (const id of [`${file}#${heading}`, `${names.outlines}/${volume}/`]) {
				assert.ok(brief.includes(`\`${id}\``), id);
				assert.ok(graph.nodes.has(id), id);
			}
			assert.ok(graph.nodes.has(`${file}#${heading} (2)`));
			assert.ok(brief.includes(`\`${file}#${heading}/${below}\``));
			assert.ok(deeper.nodes.has(`${file}#${heading}/${below}`));
			assert.equal(deeper.nodes.get(file)?.kind, 'file');

			const mark = /```json\n(.*)\n```/.exec(brief)![1];
			assert.deepEqual(Object.keys(JSON.parse(mark)), ['by', 'state']);
			const written = `{ "version": 1, "chapter": "${names.chapters}/${volume}/${chapter}.md", "marks": [${mark}] }`;
			assert.ok(brief.includes(`\`${written.replace(mark, ' … ')}\``));
			assert.equal(hasOpenMarks(written), true);
			const [filled] = parseBuoyFile(written, (state) => markAt('', 0, state, 'assistant', new Date(0)))!.marks;
			assert.equal(filled.by, 'assistant');
			assert.equal(resolve(graph, filled.state)?.nodes[0], graph.nodes.get(`${file}#${heading}`));
		}
	});

	test('in English for a story with English names', () => {
		const brief = workspaceBrief(EN);
		for (const part of [
			'`manuscript/`: the chapters',
			'`manuscript/Volume 1/Chapter 3.md` → `outlines/Volume 1/Chapter 3.md`',
			'the outline of the whole book is `outlines/book.md`',
			'- `lore/`: lore entries',
			'chapters included, and what is in `.novel-helper/` apart from the snapshots, without asking for each one',
			'not allowed by default',
			'`.novel-helper/snapshots/` are the snapshots: leave them alone',
			'## The outline graph and the buoys',
			'`manuscript/Volume 1/Chapter 3.md` → `.novel-helper/buoys/manuscript/Volume 1/Chapter 3.md.json`',
			'Do not write `at`, `before`, `chars` or `time`',
			'when you changed headings or the structure of the outline',
		]) {
			assert.ok(brief.includes(part), part);
		}
		assert.doesNotMatch(brief, /[一-鿿]/);
	});
});

describe('what goes with a message', () => {
	test('the open file and the cursor', () => {
		assert.equal(editorContextBlock({ path: '正文/第一卷/第2章 灯塔.md', line: 14 }, 'zh'), '<editor-context>\n当前打开的文件：正文/第一卷/第2章 灯塔.md\n光标在第 14 行，没有选中文字。\n</editor-context>');
		assert.deepEqual(editorContextLabel({ path: '正文/第一卷/第2章 灯塔.md', line: 14 }), { file: '第2章 灯塔.md', selected: 0 });
	});

	test('the selection with its place', () => {
		const context = { path: 'manuscript/Chapter 2.md', line: 3, selection: { text: 'The fog came in.', startLine: 3, startColumn: 1, endLine: 3, endColumn: 17 } };
		assert.equal(
			editorContextBlock(context, 'en'),
			'<editor-context>\nOpen file: manuscript/Chapter 2.md\nSelected: line 3, column 1 to line 3, column 17, 16 characters:\n<selection>\nThe fog came in.\n</selection>\n</editor-context>',
		);
		assert.deepEqual(editorContextLabel(context), { file: 'Chapter 2.md', selected: 16 });
	});

	test('a very long selection is cut, and says so', () => {
		const block = editorContextBlock({ path: '正文/第1章.md', line: 1, selection: { text: '雾'.repeat(MAX_SELECTION_CHARS + 5), startLine: 1, startColumn: 1, endLine: 90, endColumn: 2 } }, 'zh')!;
		assert.ok(block.includes(`共 ${MAX_SELECTION_CHARS + 5} 字；太长，下面只有开头的 ${MAX_SELECTION_CHARS} 字`));
		assert.equal(block.match(/雾/g)!.length, MAX_SELECTION_CHARS);
	});

	test('no file of the story open: only the notes, or nothing', () => {
		assert.equal(editorContextBlock({}, 'zh'), undefined);
		assert.equal(editorContextLabel({}), undefined);
		assert.equal(editorContextBlock({ notes: ['作者把文件退回到了第 3 轮之前。'] }, 'zh'), '<editor-context>\n作者把文件退回到了第 3 轮之前。\n</editor-context>');
	});
});

describe('which requests go through unasked', () => {
	const story = path.resolve('/books/雾港');
	const at = (...parts: string[]) => path.join(story, ...parts);

	test('where a file is', () => {
		assert.equal(locate(story, at('正文', '第一卷', '第1章.md')), 'inside');
		assert.equal(locate(story, at('全书.md')), 'inside');
		// The extension's own folder is part of the story, the snapshots aside.
		assert.equal(locate(story, at('.novel-helper', 'project.json')), 'inside');
		assert.equal(locate(story, at('.novel-helper', 'buoys', '正文', '第一卷', '第1章.md.json')), 'inside');
		assert.equal(locate(story, at('.novel-helper', 'templates', '人物.md')), 'inside');
		assert.equal(locate(story, at('.novel-helper', 'snapshots', 'turns', '000001.json')), 'hidden');
		assert.equal(locate(story, at('.novel-helper', 'snapshots', '.gitignore')), 'hidden');
		assert.equal(locate(story, at('.novel-helper', '.cache', 'x.json')), 'hidden');
		assert.equal(locate(story, at('正文', '.novel-helper', 'project.json')), 'hidden');
		assert.equal(locate(story, at('.vscode', 'settings.json')), 'hidden');
		assert.equal(locate(story, at('.git', 'hooks', 'pre-commit')), 'hidden');
		assert.equal(locate(story, at('资料', '.obsidian', 'app.json')), 'hidden');
		assert.equal(locate(story, at('.gitignore')), 'inside');
		assert.equal(locate(story, path.resolve('/books/雾港2/正文/第1章.md')), 'outside');
		assert.equal(locate(story, path.resolve('/books/other.md')), 'outside');
		assert.equal(locate(story, story), 'outside');
	});

	test('reading and changing files of the story goes through; the rest is asked about', () => {
		assert.equal(decide('read', ['inside']), 'allow');
		assert.equal(decide('search', ['inside', 'hidden']), 'allow');
		assert.equal(decide('edit', ['inside', 'inside']), 'allow');
		assert.equal(decide('delete', ['inside']), 'allow');
		assert.equal(decide('move', ['inside', 'inside']), 'allow');
		// Outside, in a dot folder, or with nothing to tell where it reaches.
		assert.equal(decide('read', ['outside']), 'ask');
		assert.equal(decide('edit', ['inside', 'outside']), 'ask');
		assert.equal(decide('edit', ['hidden']), 'ask');
		// What a snapshot does not hold can be read, but a change to it could not be gone back from.
		assert.equal(decide('read', ['unkept']), 'allow');
		assert.equal(decide('edit', ['unkept']), 'ask');
		assert.equal(decide('delete', ['inside', 'unkept']), 'ask');
		assert.equal(decide('edit', []), 'ask');
		assert.equal(decide('read', []), 'ask');
		// Commands, the network, anything else.
		for (const kind of ['execute', 'fetch', 'other', 'think', 'switch_mode', undefined, null]) {
			assert.equal(decide(kind, ['inside']), 'ask', String(kind));
		}
	});

	test('the files of a tool call are its locations and its diffs; letting through is for this once', () => {
		assert.deepEqual(pathsOf({ locations: [{ path: '/a' }, { path: '/b' }], content: [{ type: 'diff', path: '/b' }, { type: 'diff', path: '/c' }, { type: 'content' }] }), ['/a', '/b', '/c']);
		assert.deepEqual(pathsOf({ locations: null }), []);
		assert.equal(allowOnce([{ optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }]), 'once');
		assert.equal(allowOnce([{ optionId: 'always', kind: 'allow_always' }]), undefined);
	});
});

describe('the session\'s updates become the panel\'s list', () => {
	const chunk = (sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', text: string): SessionUpdate => ({ sessionUpdate, content: { type: 'text', text } });

	test('chunks of text grow one item; a thought or a tool call in between starts the next', () => {
		const list = new Transcript();
		list.push({ kind: 'user', text: '改短' });
		assert.equal(list.apply(chunk('agent_thought_chunk', '先读')), 1);
		assert.equal(list.apply(chunk('agent_thought_chunk', '文件')), 1);
		assert.equal(list.apply(chunk('agent_message_chunk', '我读了')), 2);
		assert.equal(list.apply(chunk('agent_message_chunk', '设定。')), 2);
		assert.equal(list.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', kind: 'edit', status: 'pending' }), 3);
		assert.equal(list.apply(chunk('agent_message_chunk', '改好了。')), 4);
		assert.deepEqual(list.items.slice(1), [
			{ kind: 'thought', text: '先读文件' },
			{ kind: 'agent', text: '我读了设定。' },
			{ kind: 'tool', id: 't1', title: 'Edit', tool: 'edit', status: 'pending', paths: [] },
			{ kind: 'agent', text: '改好了。' },
		]);
	});

	test('a tool call takes its title, files and state from the updates that follow, each carrying only what changed', () => {
		const list = new Transcript();
		const name = (file: string) => file.replace('/story/', '');
		list.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', kind: 'edit', status: 'pending', locations: [], rawInput: {} }, name);
		list.apply({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Terminal', kind: 'execute', status: 'pending' }, name);
		assert.equal(list.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Edit 正文/第1章.md', locations: [{ path: '/story/正文/第1章.md' }] }, name), 0);
		list.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'diff', path: '/story/正文/第1章.md', oldText: '长', newText: '短' }] }, name);
		list.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, name);
		list.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't2', title: 'echo hi', status: 'failed' }, name);
		assert.deepEqual(list.items, [
			{ kind: 'tool', id: 't1', title: 'Edit 正文/第1章.md', tool: 'edit', status: 'completed', paths: ['正文/第1章.md'] },
			{ kind: 'tool', id: 't2', title: 'echo hi', tool: 'execute', status: 'failed', paths: [] },
		]);
		// An update for a call that was never announced still shows.
		assert.equal(list.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't9', title: 'Read', status: 'in_progress' }), 2);
	});

	test('one plan a turn, replaced as it changes', () => {
		const list = new Transcript([{ kind: 'user', text: '一' }, { kind: 'plan', entries: [{ content: '旧', status: 'completed' }] }, { kind: 'user', text: '二' }]);
		const plan = (status: 'pending' | 'completed'): SessionUpdate => ({ sessionUpdate: 'plan', entries: [{ content: '读设定', priority: 'medium', status }] });
		assert.equal(list.apply(plan('pending')), 3);
		assert.equal(list.apply(plan('completed')), 3);
		assert.deepEqual(list.items[3], { kind: 'plan', entries: [{ content: '读设定', status: 'completed' }] });
		assert.deepEqual(list.items[1], { kind: 'plan', entries: [{ content: '旧', status: 'completed' }] });
	});

	test('updates the panel shows nothing of', () => {
		const list = new Transcript();
		assert.equal(list.apply({ sessionUpdate: 'usage_update', used: 1, size: 2 }), undefined);
		assert.equal(list.apply({ sessionUpdate: 'available_commands_update', availableCommands: [] }), undefined);
		assert.equal(list.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '重放' } }), undefined);
		assert.equal(list.apply(chunk('agent_message_chunk', '')), undefined);
		assert.deepEqual(list.items, []);
	});

	test('the end of a turn stops what was still running and closes open questions', () => {
		const ask: Item = { kind: 'ask', id: 'a1', title: 'echo hi', detail: '', options: [] };
		const answered: Item = { kind: 'ask', id: 'a0', title: 'ls', detail: '', options: [], answer: 'Allow' };
		const list = new Transcript([
			{ kind: 'tool', id: 't0', title: 'old', status: 'pending', paths: [] },
			{ kind: 'user', text: '跑一下' },
			{ kind: 'tool', id: 't1', title: 'done', status: 'completed', paths: [] },
			answered,
			{ kind: 'tool', id: 't2', title: 'running', status: 'in_progress', paths: [] },
			ask,
		]);
		assert.equal(list.ask('a1'), ask);
		assert.equal(list.ask('nope'), undefined);
		assert.deepEqual(list.endTurn({ kind: 'turn', stop: 'cancelled', changes: [] }), [5, 4, 6]);
		assert.deepEqual(list.items.map((item) => ('status' in item ? item.status : 'closed' in item ? 'closed' : item.kind)), ['pending', 'user', 'completed', 'ask', 'stopped', 'closed', 'turn']);
	});

	test('only the end of a long list is kept for the next window', () => {
		const list = new Transcript(Array.from({ length: 320 }, (_, i): Item => ({ kind: 'agent', text: String(i) })));
		const kept = list.kept();
		assert.equal(kept.length, 300);
		assert.deepEqual(kept[0], { kind: 'agent', text: '20' });
	});
});
