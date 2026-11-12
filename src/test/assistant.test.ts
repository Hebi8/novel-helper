// The assistant as a whole: the extension activated against the stand-in for
// `vscode`, its panel driven the way the page drives it, and the fake agent
// of this folder as the agent.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { type BuoyFile, buoyPath } from '../core/buoy';
import { SNAPSHOT_DIR, type SnapshotRecord } from '../core/snapshot';
import { MARKER_FILE, serializeMarker } from '../core/story';
import type { Item } from '../core/transcript';
import { filesIn, type Panel, start, type Started } from './vscodeStub';

const FAKE_AGENT = path.join(__dirname, 'fakeAgent.js');
const VIEW = 'novelHelper.assistant';
const MARKER = serializeMarker({ version: 1, language: 'zh', folders: { chapters: '正文', outlines: '大纲', summaries: '摘要', lore: ['设定'] }, book: '全书' });
const STORY = { [MARKER_FILE]: MARKER, '正文/第一卷/第1章.md': '清晨的雾。\n阿栀推开了门。\n', '设定/雾港.md': '北方的小港口。\n' };
const CHAPTER = '正文/第一卷/第1章.md';

const started: Started[] = [];
after(() => started.forEach((one) => one.dispose()));

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;

interface Chat {
	one: Started;
	panel: Panel;
	/** Sends a message and waits for the turn to end, or for the message to come back unsent. */
	say(text: string): Promise<void>;
	/** Sends a message without waiting. */
	begin(text: string): void;
	/** Waits until the panel is no longer busy. */
	idle(): Promise<void>;
	/** Clicks "go back" on a turn and waits for it to be over; `confirm` says whether the question that follows is answered with yes. */
	goBack(record: number, confirm?: boolean): Promise<void>;
	/** The list as the page has it now. */
	items(): Item[];
	of<K extends Item['kind']>(kind: K): Array<Of<K>>;
	/** What the agent said in the last turn. */
	said(): string;
	records(): SnapshotRecord[];
}

async function until<T>(get: () => T | undefined | false | null, what: string): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const value = get();
		if (value) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function chatOn(one: Started): Chat {
	const panel = one.panel(VIEW);
	panel.send({ type: 'ready' });
	const items = () => {
		let list: Item[] = [];
		for (const message of panel.posted) {
			if (message.type === 'init') {
				list = [...message.items];
			} else if (message.type === 'item') {
				list[message.index] = message.item;
			}
		}
		return list;
	};
	let mark = 0;
	const idle = async () => {
		await until(() => panel.posted.slice(mark).some((message) => message.type === 'draft' || (message.type === 'state' && !message.busy)), 'the end of the turn');
		await new Promise((resolve) => setTimeout(resolve, 20));
	};
	const begin = (text: string) => {
		mark = panel.posted.length;
		panel.send({ type: 'send', text });
	};
	const of = <K extends Item['kind']>(kind: K) => items().filter((item): item is Of<K> => item.kind === kind);
	return {
		one,
		panel,
		begin,
		idle,
		say: async (text) => {
			begin(text);
			await idle();
		},
		goBack: async (record, confirm = true) => {
			one.answers.push((buttons) => (confirm ? buttons[0] : undefined));
			mark = panel.posted.length;
			panel.send({ type: 'revert', record });
			await idle();
		},
		items,
		of,
		said: () => {
			const list = items();
			const from = list.map((item) => item.kind).lastIndexOf('user');
			return list.slice(from).flatMap((item) => (item.kind === 'agent' ? [item.text] : [])).join('');
		},
		records: () => {
			const turns = path.join(one.workspace, SNAPSHOT_DIR, 'turns');
			return filesIn(turns).map((file) => JSON.parse(fs.readFileSync(path.join(turns, file), 'utf8')) as SnapshotRecord);
		},
	};
}

/** A workspace with these files, the fake agent (with these flags) as a custom agent, and the panel open. */
async function chat(files: Record<string, string> = STORY, flags: string[] = [], settings: Record<string, unknown> = {}): Promise<Chat> {
	const one = await start(
		(folder) => {
			for (const [file, content] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
				fs.writeFileSync(path.join(folder, file), content);
			}
		},
		{ 'novelHelper.assistant.agent': 'custom', 'novelHelper.assistant.command': process.execPath, 'novelHelper.assistant.args': [FAKE_AGENT, ...flags], ...settings },
	);
	started.push(one);
	return chatOn(one);
}

/** The last message of a type that the page was sent. */
const last = (panel: Panel, type: string) => panel.posted.filter((message) => message.type === type).at(-1);
const storyFiles = (one: Started) => one.files().filter((file) => !file.startsWith('.novel-helper/'));

describe('the panel', () => {
	test('its page loads one script and one style sheet of the extension and nothing else', async () => {
		const { panel } = await chat();
		const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(panel.html)![1];
		assert.match(policy, /^default-src 'none'; style-src vscode-resource:; script-src 'nonce-[A-Za-z0-9]{32}';$/);
		assert.doesNotMatch(panel.html, /unsafe-inline|unsafe-eval|https?:|<img|style=|onclick/);
		assert.equal(panel.html.match(/<script/g)!.length, 1);
		assert.match(panel.html, /<script nonce="[A-Za-z0-9]{32}" src="vscode-resource:[^"]*\/dist\/assistant\.js"><\/script>/);
		assert.deepEqual(panel.options.localResourceRoots.map((root: { path: string }) => path.basename(root.path)), ['dist', 'media']);
		const init = panel.posted.find((message) => message.type === 'init');
		assert.deepEqual(init.items, []);
		assert.equal(init.busy, false);
		assert.equal(init.strings.send, 'Send');
	});

	test('links are opened only when they go to the web', async () => {
		const { one, panel } = await chat();
		panel.send({ type: 'link', href: 'https://example.com/a' });
		panel.send({ type: 'link', href: 'command:workbench.action.terminal.new' });
		panel.send({ type: 'link', href: 'file:///etc/passwd' });
		assert.deepEqual(one.external, ['https://example.com/a']);
	});
});

describe('a turn', () => {
	test('the answer streams in, the tool calls show, and the turn ends with what it changed on disk', async () => {
		const talk = await chat();
		await talk.say(`think 先看看\nwrite ${CHAPTER} 雾。\nwrite 摘要/第1章.md 摘要\nsay 改好了`);
		assert.deepEqual(talk.items(), [
			{ kind: 'user', text: `think 先看看\nwrite ${CHAPTER} 雾。\nwrite 摘要/第1章.md 摘要\nsay 改好了` },
			{ kind: 'thought', text: '先看看' },
			{ kind: 'tool', id: 'call-1', title: `Write ${CHAPTER}`, tool: 'edit', status: 'completed', paths: [CHAPTER] },
			{ kind: 'tool', id: 'call-2', title: 'Write 摘要/第1章.md', tool: 'edit', status: 'completed', paths: ['摘要/第1章.md'] },
			{ kind: 'agent', text: '改好了' },
			{
				kind: 'turn',
				record: 1,
				stop: 'end_turn',
				changes: [
					{ path: '摘要/第1章.md', after: talk.records()[0].changes![0].after },
					{ path: CHAPTER, before: talk.records()[0].files[CHAPTER], after: talk.records()[0].changes![1].after },
				],
			},
		]);
		assert.equal(talk.one.read(CHAPTER), '雾。');
		assert.equal(talk.records()[0].title, 'think 先看看');
		// The page was told when it was busy and when not, with a word on what is going on.
		const states = talk.panel.posted.filter((message) => message.type === 'state');
		assert.deepEqual(states.map((state) => state.busy), [true, true, false]);
		assert.deepEqual(states.map((state) => state.status), ['Starting the agent…', 'The agent is working…', '']);
		// The agent is running now: the next message does not say it is being started.
		await talk.say('say 好');
		assert.equal(talk.panel.posted.filter((message) => message.type === 'state').at(-3).status, 'The agent is working…');
	});

	test('a turn that changes nothing leaves no snapshot, and nothing to go back to', async () => {
		const talk = await chat();
		await talk.say('say 这一章节奏不错');
		assert.deepEqual(talk.of('turn'), [{ kind: 'turn', stop: 'end_turn', changes: [] }]);
		assert.deepEqual(talk.records(), []);
	});

	test('what the editor shows goes along: the open file, the selection and where it is', async () => {
		const talk = await chat();
		await talk.one.vscode.window.showTextDocument(talk.one.vscode.Uri.file(path.join(talk.one.workspace, CHAPTER)));
		talk.one.select(1, 0, 1, 2);
		await until(() => last(talk.panel, 'context')?.text === '第1章.md · 2 characters selected', 'the context line');
		await talk.say('echo');
		const [brief, context] = talk.said().split('\n---\n');
		// This agent takes no system prompt: the brief is in front of the first message.
		assert.match(brief, /^你在帮一位作者写小说。/);
		assert.ok(brief.includes('`正文/第一卷/第3章.md` → `大纲/第一卷/第3章.md`'));
		assert.equal(context, `<editor-context>\n当前打开的文件：${CHAPTER}\n选中了第 2 行第 1 列到第 2 行第 3 列，共 2 字：\n<selection>\n阿栀\n</selection>\n</editor-context>`);
		assert.equal(talk.of('user')[0].context, '第1章.md · 2 characters selected');
		// Only the first message carries the brief.
		talk.one.select(0, 0, 0, 0);
		await talk.say('echo');
		assert.equal(talk.said(), `<editor-context>\n当前打开的文件：${CHAPTER}\n光标在第 1 行，没有选中文字。\n</editor-context>`);
	});

	test('an agent that takes a system prompt gets the brief there, and messages without it', async () => {
		const talk = await chat(STORY, ['--system-prompt']);
		await talk.say('system');
		assert.match(talk.said(), /^你在帮一位作者写小说。[\s\S]*`设定\/`：设定条目/);
		await talk.say('echo');
		assert.equal(talk.said(), '');
	});

	test('unsaved edits are saved before the turn: the agent reads the disk, and so does the snapshot', async () => {
		const talk = await chat();
		await talk.one.vscode.window.showTextDocument(talk.one.vscode.Uri.file(path.join(talk.one.workspace, CHAPTER)));
		talk.one.type(CHAPTER, '还没保存的一稿。\n');
		await talk.say(`fsread ${CHAPTER}`);
		assert.equal(talk.said(), `read ${CHAPTER}: 还没保存的一稿。\n`);
		assert.equal(talk.one.read(CHAPTER), '还没保存的一稿。\n');
		// Saved before the snapshot was taken, so it is not something the turn changed.
		assert.deepEqual(talk.of('turn')[0].changes, []);
	});

	test('it can be stopped', async () => {
		const talk = await chat();
		talk.begin('say 开始\nwait\nsay 到不了这里');
		await until(() => talk.said() === '开始', 'the start of the answer');
		talk.panel.send({ type: 'stop' });
		await talk.idle();
		assert.equal(talk.of('turn')[0].stop, 'cancelled');
		assert.equal(talk.said(), '开始');
		// The agent is still there for the next message.
		await talk.say('say 还在');
		assert.equal(talk.said(), '还在');
	});
});

describe('what the agent may do', () => {
	test('changing files of the story goes through unasked', async () => {
		const talk = await chat();
		await talk.say('ask edit 正文/第一卷/第2章.md\nask read 设定/雾港.md');
		assert.equal(talk.said(), 'answer: yesanswer: yes');
		assert.deepEqual(talk.of('ask'), []);
		assert.equal(talk.one.read('正文/第一卷/第2章.md'), 'asked');
	});

	test('so does changing what the extension keeps of the story in its own folder, and going back takes it along', async () => {
		const talk = await chat();
		await talk.say('ask edit .novel-helper/templates/人物.md\nask edit .novel-helper/project.json');
		assert.equal(talk.said(), 'answer: yesanswer: yes');
		assert.deepEqual(talk.of('ask'), []);
		const turn = talk.of('turn')[0];
		assert.deepEqual(turn.changes.map((change) => change.path), ['.novel-helper/project.json', '.novel-helper/templates/人物.md']);
		await talk.goBack(turn.record!);
		assert.equal(talk.one.read(MARKER_FILE), MARKER);
		assert.ok(!talk.one.files().includes('.novel-helper/templates/人物.md'));
	});

	test('a command is put to the writer, and runs only when allowed', async () => {
		const talk = await chat();
		talk.begin('run rm -rf 正文');
		const ask = await until(() => talk.of('ask')[0], 'the question');
		assert.deepEqual(ask, {
			kind: 'ask',
			id: '1',
			title: 'rm -rf 正文',
			detail: '',
			// The agent also offered "Always allow": only yes or no to this one request is put to the writer.
			options: [
				{ id: 'yes', name: 'Allow Once', kind: 'allow_once' },
				{ id: 'no', name: 'Do Not Allow', kind: 'reject_once' },
			],
		});
		talk.panel.send({ type: 'answer', id: ask.id, option: 'no' });
		await talk.idle();
		assert.equal(talk.said(), 'answer: no');
		assert.equal(talk.of('ask')[0].answer, 'Do Not Allow');

		talk.begin('run ls');
		const second = await until(() => talk.of('ask')[1], 'the second question');
		talk.panel.send({ type: 'answer', id: second.id, option: 'yes' });
		await talk.idle();
		assert.equal(talk.said(), 'answer: yes');
	});

	test('a path outside the story folder, in a hidden folder of it, or among the snapshots is asked about; no answer is no', async () => {
		const talk = await chat();
		const asked = ['edit ../outside.md', 'edit .vscode/settings.json', `edit ${SNAPSHOT_DIR}/turns/000001.json`, 'read ../outside.md'];
		talk.begin(asked.map((one) => `ask ${one}`).join('\n'));
		for (const [n, title] of asked.entries()) {
			const ask = await until(() => talk.of('ask')[n], `question ${n}`);
			assert.equal(ask.title, title);
			assert.equal(ask.detail, n === 1 || n === 2 ? title.slice('edit '.length) : path.join(talk.one.base, 'outside.md'));
			// An answer the panel did not offer is no answer.
			talk.panel.send({ type: 'answer', id: ask.id, option: n === 1 ? 'always' : 'no' });
		}
		await talk.idle();
		assert.equal(talk.said(), 'answer: noanswer: cancelledanswer: noanswer: no');
		assert.equal(talk.of('ask')[1].closed, true);
		assert.equal(fs.existsSync(path.join(talk.one.base, 'outside.md')), false);
		assert.ok(!talk.one.files().some((file) => file.startsWith('.vscode/') || file.startsWith(`${SNAPSHOT_DIR}/turns/000001`)));

		// Stopping the turn while a question is open answers it with no.
		talk.begin('run curl example.com\nwait');
		await until(() => talk.of('ask')[4], 'the open question');
		talk.panel.send({ type: 'stop' });
		await talk.idle();
		assert.equal(talk.of('ask')[4].closed, true);
		assert.equal(talk.of('ask')[4].answer, undefined);
	});

	test('a link inside the story folder that leads out of it counts as outside', async () => {
		const talk = await chat();
		fs.mkdirSync(path.join(talk.one.base, 'elsewhere'));
		fs.symlinkSync(path.join(talk.one.base, 'elsewhere'), path.join(talk.one.workspace, '资料'));
		talk.begin('ask edit 资料/笔记.md');
		const ask = await until(() => talk.of('ask')[0], 'the question');
		talk.panel.send({ type: 'answer', id: ask.id, option: 'no' });
		await talk.idle();
		assert.deepEqual(fs.readdirSync(path.join(talk.one.base, 'elsewhere')), []);
	});

	test('a file that snapshots do not hold (not text, or a folder) is asked about before it is changed', async () => {
		const talk = await chat();
		fs.mkdirSync(path.join(talk.one.workspace, '资料/node_modules/x'), { recursive: true });
		fs.writeFileSync(path.join(talk.one.workspace, '资料/地图.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
		talk.begin('ask read 资料/地图.png\nask edit 资料/地图.png\nask edit 正文/第一卷\nask edit 资料/node_modules/x/index.js');
		for (const n of [0, 1, 2]) {
			const ask = await until(() => talk.of('ask')[n], `question ${n}`);
			assert.equal(ask.title, ['edit 资料/地图.png', 'edit 正文/第一卷', 'edit 资料/node_modules/x/index.js'][n]);
			talk.panel.send({ type: 'answer', id: ask.id, option: 'no' });
		}
		await talk.idle();
		assert.equal(talk.said(), 'answer: yesanswer: noanswer: noanswer: no');
	});

	test('an agent that reads and writes through the client: inside the story as it likes, elsewhere only when allowed', async () => {
		const talk = await chat();
		fs.writeFileSync(path.join(talk.one.base, 'secret.txt'), '外面的东西');
		talk.begin(`fswrite 正文/第一卷/第2章.md 第二章\nfsread ${CHAPTER}\nfswrite ../outside.md 不该写\nfsread ../secret.txt`);
		for (const n of [0, 1]) {
			const ask = await until(() => talk.of('ask')[n], `question ${n}`);
			assert.equal(ask.detail, path.join(talk.one.base, n === 0 ? 'outside.md' : 'secret.txt'));
			talk.panel.send({ type: 'answer', id: ask.id, option: 'reject' });
		}
		await talk.idle();
		assert.match(talk.said(), /^wrote 正文\/第一卷\/第2章\.mdread 正文\/第一卷\/第1章\.md: 清晨的雾。\n阿栀推开了门。\ncould not write \.\.\/outside\.md: .*could not read \.\.\/secret\.txt: /s);
		assert.doesNotMatch(talk.said(), /外面的东西/);
		assert.equal(talk.one.read('正文/第一卷/第2章.md'), '第二章');
		assert.equal(fs.existsSync(path.join(talk.one.base, 'outside.md')), false);
		assert.deepEqual(talk.of('turn')[0].changes.map((change) => change.path), ['正文/第一卷/第2章.md']);
	});
});

describe('looking at a turn and going back', () => {
	test('a changed file opens as a diff of before and after the turn', async () => {
		const talk = await chat();
		await talk.say(`write ${CHAPTER} 雾。\nwrite 摘要/第1章.md 摘要\ndelete 设定/雾港.md`);
		const provider = talk.one.providers['novel-helper-snapshot'];
		for (const [n, file] of [CHAPTER, '摘要/第1章.md', '设定/雾港.md'].entries()) {
			talk.panel.send({ type: 'diff', record: 1, path: file });
			await until(() => talk.one.diffs.length === n + 1, `diff ${n}`);
		}
		const [modified, added, removed] = talk.one.diffs;
		// Changed: the snapshot on the left, the file itself on the right, where it can be edited.
		assert.equal(modified[0].scheme, 'novel-helper-snapshot');
		assert.equal(modified[0].path, `/${CHAPTER}`);
		assert.equal(await provider.provideTextDocumentContent(modified[0]), '清晨的雾。\n阿栀推开了门。\n');
		assert.equal(modified[1].fsPath, path.join(talk.one.workspace, CHAPTER));
		assert.equal(modified[2], '第1章.md (before ↔ after #1)');
		// New: nothing on the left. Deleted: nothing on the right.
		assert.equal(await provider.provideTextDocumentContent(added[0]), '');
		assert.equal(added[1].fsPath, path.join(talk.one.workspace, '摘要/第1章.md'));
		assert.equal(await provider.provideTextDocumentContent(removed[0]), '北方的小港口。\n');
		assert.equal(await provider.provideTextDocumentContent(removed[1]), '');

		// Once the file was written again, the right side is the turn's own result, not what is on disk now.
		talk.one.write(CHAPTER, '后来手改的');
		talk.panel.send({ type: 'diff', record: 1, path: CHAPTER });
		await until(() => talk.one.diffs.length === 4, 'the fourth diff');
		assert.equal(talk.one.diffs[3][1].scheme, 'novel-helper-snapshot');
		assert.equal(await provider.provideTextDocumentContent(talk.one.diffs[3][1]), '雾。');
	});

	test('going back to before a turn asks first, restores the files, and can itself be undone', async () => {
		const talk = await chat();
		await talk.say(`write ${CHAPTER} 第一轮`);
		await talk.say(`write ${CHAPTER} 第二轮\nwrite 正文/第一卷/第2章.md 新的一章\ndelete 设定/雾港.md`);
		const before = storyFiles(talk.one);

		// Asked, and not confirmed: nothing happens.
		await talk.goBack(2, false);
		assert.equal(talk.one.messages.at(-1), 'Go back to before #2?');
		assert.deepEqual(storyFiles(talk.one), before);
		assert.equal(talk.one.read(CHAPTER), '第二轮');

		await talk.goBack(2);
		assert.equal(talk.one.read(CHAPTER), '第一轮');
		assert.deepEqual(storyFiles(talk.one), ['正文/第一卷/第1章.md', '设定/雾港.md']);
		const back = talk.of('turn')[2];
		assert.equal(back.stop, 'reverted');
		assert.equal(back.target, 2);
		assert.equal(back.record, 3);
		assert.deepEqual(back.changes.map((change) => change.path), ['正文/第一卷/第1章.md', '正文/第一卷/第2章.md', '设定/雾港.md']);

		// The agent hears of it with the next message.
		await talk.say('echo');
		assert.match(talk.said(), /<editor-context>\n作者刚把故事目录退回到了更早的样子，这些文件变了：正文\/第一卷\/第1章\.md、正文\/第一卷\/第2章\.md、设定\/雾港\.md。/);

		// Undoing the going back: back to before record 3.
		await talk.goBack(3);
		assert.equal(talk.one.read(CHAPTER), '第二轮');
		assert.deepEqual(storyFiles(talk.one), before);
	});

	test('unsaved edits are kept by going back: they are saved into the snapshot taken first', async () => {
		const talk = await chat();
		await talk.say(`write ${CHAPTER} 第一轮`);
		await talk.one.vscode.window.showTextDocument(talk.one.vscode.Uri.file(path.join(talk.one.workspace, CHAPTER)));
		talk.one.type(CHAPTER, '第一轮，加上没保存的修改');
		await talk.goBack(1);
		assert.equal(talk.one.read(CHAPTER), '清晨的雾。\n阿栀推开了门。\n');
		await talk.goBack(2);
		assert.equal(talk.one.read(CHAPTER), '第一轮，加上没保存的修改');
	});

	test('the command lists the snapshots that are kept, newest first, also after the panel was cleared', async () => {
		const talk = await chat(STORY, [], { 'novelHelper.assistant.snapshots.keep': 2 });
		await talk.one.commands['novelHelper.assistant.history']();
		assert.equal(talk.one.messages.at(-1), 'No snapshots yet. One is kept for every turn of the assistant that changes files.');
		for (const text of ['一', '二', '三']) {
			await talk.say(`write ${CHAPTER} ${text}`);
		}
		await talk.one.commands['novelHelper.assistant.newSession']();
		assert.deepEqual(talk.items(), []);
		// Only two are kept: the first turn's is gone, and so is what the chapter was before it.
		assert.deepEqual(talk.records().map((record) => record.id), [2, 3]);
		talk.one.answers.push(
			(picks) => picks[1],
			(buttons) => buttons[0],
		);
		await talk.one.commands['novelHelper.assistant.history']();
		const pick = talk.one.asked.at(-1)!;
		assert.deepEqual(pick.items, [`#3 write ${CHAPTER} 三`, `#2 write ${CHAPTER} 二`]);
		assert.equal(talk.one.read(CHAPTER), '一');
		// A snapshot that is gone cannot be opened or gone back to; the writer is told.
		talk.panel.send({ type: 'diff', record: 1, path: CHAPTER });
		await until(() => talk.one.messages.at(-1) === 'That snapshot is no longer kept: only the last 2 are.', 'the message');
		assert.deepEqual(talk.one.diffs, []);
	});
});

describe('an agent that cannot be used', () => {
	const errors = (talk: Chat) => talk.of('notice').filter((notice) => notice.level === 'error');
	/** The last message was not sent: it is back in the input box. */
	const returned = (talk: Chat) => last(talk.panel, 'draft')?.text;

	test('a command that is not there: the panel says so, and the message comes back', async () => {
		const talk = await chat(STORY, [], { 'novelHelper.assistant.command': 'novel-helper-no-such-command' });
		await talk.say('say 你好');
		assert.equal(errors(talk)[0].text, 'Could not start the agent: the command "novel-helper-no-such-command" was not found. Check novelHelper.assistant.command; a full path always works.');
		assert.equal(returned(talk), 'say 你好');
		assert.deepEqual(talk.of('user'), []);
		assert.deepEqual(talk.records(), []);
	});

	test('no command set for a custom agent; a folder that is not trusted; no story folder', async () => {
		const unset = await chat(STORY, [], { 'novelHelper.assistant.command': ' ' });
		await unset.say('say 你好');
		assert.match(errors(unset)[0].text, /^The custom agent has no command\./);

		const untrusted = await chat();
		untrusted.one.vscode.workspace.isTrusted = false;
		await untrusted.say('say 你好');
		assert.match(errors(untrusted)[0].text, /^The assistant is off in Restricted Mode/);
		assert.equal(returned(untrusted), 'say 你好');

		const empty = await chat({});
		await empty.say('say 你好');
		assert.match(errors(empty)[0].text, /^There is no story folder to work in yet\./);
		assert.deepEqual(empty.one.files(), []);
	});

	test('an agent that ends on start: what it wrote last is shown', async () => {
		const talk = await chat(STORY, [], { 'novelHelper.assistant.args': ['-e', 'console.error("npm error code ENOTFOUND"); process.exit(1)'] });
		await talk.say('say 你好');
		assert.match(errors(talk)[0].text, /^The agent ended as soon as it was started \(exit code 1\)\. What it wrote last is below\. Check novelHelper\.assistant\.command/);
		assert.equal(errors(talk)[0].detail, 'npm error code ENOTFOUND');
		assert.equal(returned(talk), 'say 你好');
	});

	test('an agent that is not logged in', async () => {
		const talk = await chat(STORY, ['--auth']);
		await talk.say('say 你好');
		assert.equal(errors(talk)[0].text, "The agent is not logged in. Log in with the agent's own command line, then send the message again.");
		assert.equal(returned(talk), 'say 你好');
	});

	test('an agent that ends in the middle of a turn: what it changed is still found, and the next message starts it again in the same session', async () => {
		const talk = await chat(STORY, ['--resume']);
		await talk.say('session');
		const session = talk.said().split(' ')[0];
		await talk.say(`write ${CHAPTER} 写到一半\nstderr out of memory\nexit 7`);
		const turn = talk.of('turn')[1];
		assert.equal(turn.stop, 'failed');
		assert.deepEqual(turn.changes.map((change) => change.path), [CHAPTER]);
		assert.match(errors(talk)[0].text, /^The agent ended in the middle of the turn \(exit code 7\)\. Send a message to start it again/);
		assert.equal(errors(talk)[0].detail, 'out of memory');

		await talk.say('session');
		assert.equal(talk.said().split(' ')[0], session);
		// What the broken turn changed can be gone back from like any other.
		await talk.goBack(turn.record!);
		assert.equal(talk.of('turn').at(-1)?.stop, 'reverted');
		assert.equal(talk.one.read(CHAPTER), '清晨的雾。\n阿栀推开了门。\n');
	});
});

describe('going back and turns, one at a time', () => {
	test('going back stops, and says why, when a file it would write over is no longer one a snapshot holds', async () => {
		const talk = await chat();
		await talk.say(`write ${CHAPTER} 改了。\nwrite 设定/雾港.md 也改了。`);
		const turn = talk.of('turn')[0];
		// The chapter is something else by now: no snapshot would keep it, so going back could not be undone.
		const binary = Buffer.from([0x50, 0x4b, 0, 1]);
		fs.writeFileSync(path.join(talk.one.workspace, CHAPTER), binary);
		await talk.goBack(turn.record!);
		assert.equal(talk.one.messages.at(-1), 'Did not go back to before #1: no file was changed.');
		assert.match(talk.one.details.at(-1)!, /Move or rename them, then go back again\.\n\n正文\/第一卷\/第1章\.md: is not a text file now$/);
		assert.deepEqual(fs.readFileSync(path.join(talk.one.workspace, CHAPTER)), binary);
		assert.equal(talk.one.read('设定/雾港.md'), '也改了。', 'the file that could have been put back is left as well');
		assert.deepEqual(talk.of('turn').map((one) => one.stop), ['end_turn']);
		assert.equal(talk.records().length, 1);
	});

	test('a message sent the moment going back was clicked starts no turn beside it', async () => {
		const talk = await chat();
		await talk.say(`write ${CHAPTER} 改了。`);
		const turn = talk.of('turn')[0];
		talk.one.answers.push((buttons) => buttons[0]);
		talk.panel.send({ type: 'revert', record: turn.record });
		talk.begin('write 正文/第一卷/第2章.md 同时写的。');
		await talk.idle();
		await talk.one.settle();
		assert.deepEqual(talk.of('user').map((one) => one.text), [`write ${CHAPTER} 改了。`]);
		assert.deepEqual(talk.of('turn').map((one) => one.stop), ['end_turn', 'reverted']);
		assert.deepEqual(storyFiles(talk.one), ['正文/第一卷/第1章.md', '设定/雾港.md']);
		assert.equal(talk.one.read(CHAPTER), '清晨的雾。\n阿栀推开了门。\n');
	});

	test('closing the window while the agent is being started ends its process', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-pid-'));
		try {
			const pidFile = path.join(dir, 'pid');
			const talk = await chat(STORY, ['--init-hangs', `--pid=${pidFile}`]);
			talk.begin('say 你好');
			const pid = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), 'the agent to be there'));
			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			assert.equal(alive(), true);
			talk.one.dispose();
			await until(() => !alive(), 'the agent to be gone');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the buoys', () => {
	const OUTLINED = { ...STORY, '大纲/第1章.md': '## 来信\n\n信送不出去。\n\n## 等门\n\n等到傍晚。\n', '正文/第1章.md': '---\ntitle: 第1章\n---\n清晨的雾。\n阿栀推开了门。\n' };
	const BUOYS = buoyPath('正文/第1章.md');
	const moveTo = (title: string) => JSON.stringify({ by: 'assistant', state: { kind: 'in', nodes: [{ id: `大纲/第1章.md#${title}`, title }] } });
	const marks = (talk: Chat) => (JSON.parse(talk.one.read(BUOYS)) as BuoyFile).marks;
	const shown = async (talk: Chat) => {
		await talk.one.settle();
		return talk.one.views['novelHelper.outline'].message as string;
	};

	test('a mark the agent adds with only the buoys in it is filled in from the chapter, and the outline view and the status bar follow; so they do on going back', async () => {
		const talk = await chat(OUTLINED);
		const { one } = talk;
		await one.vscode.window.showTextDocument(one.vscode.Uri.file(path.join(one.workspace, '正文/第1章.md')));
		assert.equal(await shown(talk), '第1章: no position on the outline yet');

		await talk.say(`write ${BUOYS} {"version":1,"chapter":"正文/第1章.md","marks":[${moveTo('来信')}]}`);
		assert.deepEqual(talk.of('ask'), []);
		assert.equal(await shown(talk), '第1章: in 【来信】');
		assert.match(one.statusItem.tooltip, /\n\n第1章 on the outline: in 【来信】\n\n/);
		const text = OUTLINED['正文/第1章.md'];
		const body = '清晨的雾。\n阿栀推开了门。\n'.length;
		const [first] = marks(talk);
		assert.deepEqual({ ...first, time: '' }, { at: text.length, before: text.slice(-30), chars: body, time: '', by: 'assistant', state: JSON.parse(moveTo('来信')).state });
		assert.ok(Date.now() - Date.parse(first.time) < 60_000);

		// The next one is appended to what the extension wrote back; the chapter has grown since.
		one.type('正文/第1章.md', `${text}她等了很久。`);
		await talk.say(`write ${BUOYS} ${JSON.stringify({ version: 1, chapter: '正文/第1章.md', marks: [first, JSON.parse(moveTo('等门'))] })}`);
		assert.equal(await shown(talk), '第1章: in 【等门】');
		assert.deepEqual(marks(talk).map((mark) => [mark.by, mark.chars, mark.state.nodes[0].title]), [['assistant', body, '来信'], ['assistant', body + 6, '等门']]);
		assert.deepEqual(marks(talk)[0], first, 'a mark that is whole is left as it is');

		// A node that is not in the outline: the buoys are lost, by the rule for any mark.
		await talk.say(`write ${BUOYS} ${JSON.stringify({ version: 1, chapter: '正文/第1章.md', marks: [...marks(talk), JSON.parse(moveTo('没有的'))] })}`);
		assert.equal(await shown(talk), '第1章: lost: 【没有的】 is no longer in the outline');
		assert.equal(marks(talk).length, 3);

		// Going back puts the file back, and what is shown follows.
		const turns = talk.of('turn');
		assert.deepEqual(turns.map((turn) => turn.changes.map((change) => change.path)), [[BUOYS], [BUOYS], [BUOYS]]);
		await talk.goBack(turns[2].record!);
		assert.equal(await shown(talk), '第1章: in 【等门】');
		assert.match(one.statusItem.tooltip, /\n\n第1章 on the outline: in 【等门】\n\n/);
		await talk.goBack(turns[0].record!);
		assert.ok(!one.files().includes(BUOYS));
		assert.equal(await shown(talk), '第1章: no position on the outline yet');
	});
});

describe('conversations', () => {
	const sessionOf = (talk: Chat) => talk.said().split(' ')[0];

	test('a new conversation clears the panel and is a new session for the agent; a turn that is running is stopped first', async () => {
		const talk = await chat(STORY, ['--close']);
		await talk.say('session');
		const first = sessionOf(talk);
		talk.begin(`write ${CHAPTER} 改到一半。\nrun ls\nwait`);
		await until(() => talk.of('ask')[0], 'the question of the turn that is running');
		await talk.one.commands['novelHelper.assistant.newSession']();
		assert.deepEqual(talk.items(), []);
		assert.equal(last(talk.panel, 'state')?.busy, false);
		// The turn was wound up like any that is stopped: what it changed is kept and can be gone back from.
		assert.deepEqual(talk.records().at(-1)?.changes?.map((change) => change.path), [CHAPTER]);

		await talk.say('session');
		assert.notEqual(sessionOf(talk), first);
		assert.ok(talk.said().endsWith(`closed=${first}`));
		assert.deepEqual(talk.of('ask'), []);
	});

	test('a window that is opened again shows the conversation and goes on in the same session, when the agent can', async () => {
		const talk = await chat(STORY, ['--resume']);
		await talk.say(`write ${CHAPTER} 第一轮\nsession`);
		const session = sessionOf(talk);
		const shown = talk.items();

		await talk.one.reopen();
		const again = chatOn(talk.one);
		assert.deepEqual(again.items(), shown);
		await again.say('session');
		assert.equal(sessionOf(again), session);
		assert.deepEqual(again.of('notice'), []);
		// The turns of before can still be gone back from.
		await again.goBack(1);
		assert.equal(again.of('turn').at(-1)?.stop, 'reverted');
		assert.equal(talk.one.read(CHAPTER), '清晨的雾。\n阿栀推开了门。\n');
	});

	test('with an agent that cannot pick a session up, the window opened again says that this is a new conversation', async () => {
		const talk = await chat();
		await talk.say('session');
		const session = sessionOf(talk);
		await talk.one.reopen();
		const again = chatOn(talk.one);
		assert.equal(again.items().length, talk.items().length);
		await again.say('session');
		assert.notEqual(sessionOf(again), session);
		assert.deepEqual(again.of('notice').map((notice) => notice.text), ['The earlier conversation could not be picked up, so this is a new one: the agent does not remember what is above.']);
	});
});
