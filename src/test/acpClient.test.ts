// The ACP client against a real child process: the fake agent of this
// folder, which speaks the protocol through the SDK's agent side.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { agentCommand, AgentClient, AgentFailure, type AgentHandlers, CLAUDE_ADAPTER, type RequestPermissionRequest, type SessionUpdate } from '../acp/client';

export const FAKE_AGENT = path.join(__dirname, 'fakeAgent.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-acp-'));
const running: AgentClient[] = [];
after(() => {
	running.forEach((client) => client.stop());
	fs.rmSync(cwd, { recursive: true, force: true });
});

interface Seen extends AgentHandlers {
	updates: SessionUpdate[];
	asked: RequestPermissionRequest[];
	closed_: AgentFailure[];
	logged: string[];
	/** The text the agent said, chunks joined. */
	said(): string;
}

function seen(overrides: Partial<AgentHandlers> = {}): Seen {
	const one: Seen = {
		updates: [],
		asked: [],
		closed_: [],
		logged: [],
		said: () => one.updates.map((update) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : '')).join(''),
		update: (update) => void one.updates.push(update),
		permission: async (request) => {
			one.asked.push(request);
			return 'yes';
		},
		readFile: async () => '',
		writeFile: async () => undefined,
		closed: (failure) => void one.closed_.push(failure),
		log: (text) => void one.logged.push(text),
		...overrides,
	};
	return one;
}

async function start(handlers: AgentHandlers, ...flags: string[]): Promise<AgentClient> {
	const client = await AgentClient.start({ command: process.execPath, args: [FAKE_AGENT, ...flags], mode: 'default' }, cwd, handlers);
	running.push(client);
	return client;
}

describe('which agent is started', () => {
	test('the preset runs a fixed version of the Claude adapter through npx; a custom agent needs a command', () => {
		assert.deepEqual(agentCommand({ agent: 'claude', command: 'ignored', args: ['x'] }), { command: 'npx', args: ['-y', CLAUDE_ADAPTER], mode: 'default' });
		assert.match(CLAUDE_ADAPTER, /@\d+\.\d+\.\d+$/);
		assert.deepEqual(agentCommand({ agent: 'custom', command: ' gemini ', args: ['--acp'] }), { command: 'gemini', args: ['--acp'] });
		assert.equal(agentCommand({ agent: 'custom', command: ' ', args: [] }), undefined);
	});
});

describe('a session with an agent', () => {
	test('text and thoughts arrive as they are sent, and the turn ends', async () => {
		const handlers = seen();
		const client = await start(handlers);
		assert.deepEqual(await client.open(cwd, 'the brief'), { resumed: false, briefed: false });
		assert.equal(await client.prompt(['think 想一想\nsay 雾港的早晨']), 'end_turn');
		assert.deepEqual(
			handlers.updates.map((update) => [update.sessionUpdate, 'content' in update && update.content && 'text' in update.content ? update.content.text : undefined]),
			[
				['agent_thought_chunk', '想一想'],
				['agent_message_chunk', '雾港的'],
				['agent_message_chunk', '早晨'],
			],
		);
		assert.equal(await client.prompt(['refuse']), 'refusal');
	});

	test('the brief goes into the system prompt of an agent that takes one; else the caller is told to send it', async () => {
		const taking = seen();
		const client = await start(taking, '--system-prompt');
		assert.deepEqual(await client.open(cwd, '目录约定……'), { resumed: false, briefed: true });
		await client.prompt(['system']);
		assert.equal(taking.said(), '目录约定……');

		const other = seen();
		const plain = await start(other);
		assert.equal((await plain.open(cwd, '目录约定……')).briefed, false);
		await plain.prompt(['前情\n提要', 'echo']);
		assert.equal(other.said(), '前情\n提要');
	});

	test('an agent that writes to disk itself reports it as tool calls', async () => {
		const handlers = seen();
		const client = await start(handlers);
		await client.open(cwd, '');
		await client.prompt(['write 正文/第1章.md 雾\ndelete 正文/第1章.md\nwrite 正文/第2章.md 灯']);
		assert.deepEqual(fs.readdirSync(path.join(cwd, '正文')), ['第2章.md']);
		const calls = handlers.updates.filter((update) => update.sessionUpdate === 'tool_call');
		assert.deepEqual(calls.map((call) => [call.title, call.kind, call.locations?.[0].path]), [
			['Write 正文/第1章.md', 'edit', path.join(cwd, '正文/第1章.md')],
			['Delete 正文/第1章.md', 'delete', path.join(cwd, '正文/第1章.md')],
			['Write 正文/第2章.md', 'edit', path.join(cwd, '正文/第2章.md')],
		]);
		assert.equal(handlers.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed').length, 3);
	});

	test('reading and writing through the client goes to the handlers, and their refusal back to the agent', async () => {
		const written: Array<[string, string]> = [];
		const handlers = seen({
			readFile: async (file) => {
				if (file.endsWith('外面.md')) {
					throw new Error('outside the story folder');
				}
				return `没保存的 ${path.basename(file)}`;
			},
			writeFile: async (file, content) => void written.push([file, content]),
		});
		const client = await start(handlers);
		await client.open(cwd, '');
		await client.prompt(['fsread 正文/第3章.md\nfswrite 正文/第3章.md 新的 一段\nfsread ../外面.md']);
		assert.match(handlers.said(), /^read 正文\/第3章\.md: 没保存的 第3章\.mdwrote 正文\/第3章\.mdcould not read \.\.\/外面\.md: /);
		assert.deepEqual(written, [[path.join(cwd, '正文/第3章.md'), '新的 一段']]);
	});

	test('a permission request reaches the handler with the tool call and the options; no choice is a refusal', async () => {
		const handlers = seen();
		const client = await start(handlers);
		await client.open(cwd, '');
		await client.prompt(['ask edit 设定/雾港.md']);
		assert.equal(handlers.said(), 'answer: yes');
		assert.equal(fs.readFileSync(path.join(cwd, '设定/雾港.md'), 'utf8'), 'asked');
		const [request] = handlers.asked;
		assert.equal(request.toolCall.kind, 'edit');
		assert.deepEqual(request.toolCall.locations, [{ path: path.join(cwd, '设定/雾港.md') }]);
		assert.deepEqual(request.options.map((option) => option.kind), ['allow_always', 'allow_once', 'reject_once']);

		const refusing = seen({ permission: async () => undefined });
		const second = await start(refusing);
		await second.open(cwd, '');
		await second.prompt(['run rm -rf /']);
		assert.equal(refusing.said(), 'answer: cancelled');
	});

	test('an agent with modes is put in the one that asks; one without is left as it is', async () => {
		const handlers = seen();
		const client = await start(handlers, '--modes', '--close');
		await client.open(cwd, '');
		const first = client.sessionId!;
		await client.prompt(['session']);
		assert.equal(handlers.said(), `${first} mode=default closed=`);
		// Closing the session leaves the process for the next one.
		await client.close();
		await client.open(cwd, '');
		await client.prompt(['session']);
		assert.ok(handlers.said().endsWith(`${client.sessionId} mode=default closed=${first}`));

		const plain = seen();
		const other = await start(plain);
		await other.open(cwd, '');
		await other.close();
		await other.open(cwd, '');
		await other.prompt(['session']);
		assert.equal(plain.said(), `${other.sessionId} mode=auto closed=`);
	});

	test('starting can be given up', async () => {
		const abort = new AbortController();
		const starting = AgentClient.start({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] }, cwd, seen(), abort.signal);
		setTimeout(() => abort.abort(), 100);
		await assert.rejects(starting, (error) => error instanceof AgentFailure && error.kind === 'exited');
	});

	test('a running turn can be cancelled', async () => {
		const handlers = seen();
		const client = await start(handlers);
		await client.open(cwd, '');
		const turn = client.prompt(['say 开始\nwait\nsay 不会说到这里']);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await client.cancel();
		assert.equal(await turn, 'cancelled');
		assert.equal(handlers.said(), '开始');
	});

	test('an earlier session is picked up when the agent can, and a new one opened when it cannot or no longer has it', async () => {
		const client = await start(seen(), '--resume');
		assert.deepEqual(await client.open(cwd, '', 'earlier-7'), { resumed: true, briefed: true });
		assert.equal(client.sessionId, 'earlier-7');
		assert.equal((await client.open(cwd, '', 'gone-1')).resumed, false);
		assert.match(client.sessionId!, /^fake-/);

		const plain = await start(seen());
		assert.equal((await plain.open(cwd, '', 'earlier-7')).resumed, false);
		assert.match(plain.sessionId!, /^fake-/);
	});
});

describe('an agent that cannot be used', () => {
	const failure = (run: Promise<unknown>) =>
		run.then(
			() => assert.fail('no failure'),
			(error: unknown) => {
				assert.ok(error instanceof AgentFailure, String(error));
				return error;
			},
		);

	test('a command that is not there', async () => {
		const handlers = seen();
		const error = await failure(AgentClient.start({ command: 'novel-helper-no-such-command', args: [] }, cwd, handlers));
		assert.equal(error.kind, 'not-found');
		assert.equal(handlers.closed_.length, 1);
	});

	test('a process that ends before it answers: its exit code and what it wrote to stderr', async () => {
		const error = await failure(AgentClient.start({ command: process.execPath, args: ['-e', 'console.error("npm error network"); process.exit(3)'] }, cwd, seen()));
		assert.equal(error.kind, 'exited');
		assert.match(error.message, /exited \(3\)/);
		assert.equal(error.detail, 'npm error network');
	});

	test('an agent that is not logged in', async () => {
		const client = await start(seen(), '--auth');
		assert.equal((await failure(client.open(cwd, ''))).kind, 'auth');
	});

	test('a process that ends in the middle of a turn ends the turn, and the handlers hear of it once', async () => {
		const handlers = seen();
		const client = await start(handlers);
		await client.open(cwd, '');
		const error = await failure(client.prompt(['say 写到一半\nstderr out of memory\nexit 7']));
		assert.equal(error.kind, 'exited');
		assert.equal(error.detail, 'out of memory');
		assert.equal(handlers.said(), '写到一半');
		assert.deepEqual(handlers.closed_.map((closed) => closed.message), [error.message]);
		assert.deepEqual(handlers.logged, ['out of memory']);
	});

	test('stopping the agent is not reported as a failure', async () => {
		const handlers = seen();
		const client = await start(handlers);
		await client.open(cwd, '');
		client.stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(handlers.closed_, []);
	});
});
