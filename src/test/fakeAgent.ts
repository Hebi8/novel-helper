// An ACP agent for the tests, run as a child process. It does what the last
// block of a message says, one command per line:
//
//   say TEXT | think TEXT      text of the answer (in two chunks) or a thought
//   write PATH TEXT            writes the file to disk itself, reported as a tool call
//   delete PATH                deletes the file itself
//   fswrite PATH TEXT          writes through the client
//   fsread PATH                reads through the client and says what it got
//   ask KIND PATH              asks permission for a tool call of that kind on that path, says the answer; writes the file when an edit is allowed
//   run COMMAND                asks permission to run a command
//   echo                       says the blocks that came before this one
//   system | session           says the system prompt it was given; the session id, its mode and the sessions closed
//   config                     says the current session config option values
//   setconfig ID VALUE         changes a session config option and sends config_option_update
//   wait                       waits to be cancelled
//   refuse                     ends the turn as refused
//   stderr TEXT | exit CODE    writes to stderr; ends the process
// A JSON array can also name a command and its arguments, for paths with spaces.
//
// Flags: --resume, --system-prompt and --close declare those capabilities,
// --modes starts sessions in a mode called `auto` next to one called
// `default` (and --mode-fails refuses to change it), --options reports model
// and effort configOptions (customizable with --models=id:Name,..., --opus-high,
// --slow-set-model and --no-effort), --auth makes it ask for
// a login. --init-fails answers the first request with an error and lives
// on; --init-hangs does not answer it at all. --pid=FILE writes the
// process id to FILE on start.
// --exit-on-start writes to stderr and exits before initialization.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { SessionConfigOption } from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };

async function main(): Promise<void> {
	const acp = await import('@agentclientprotocol/sdk');
	const flags = new Set(process.argv.slice(2));
	const pidFile = process.argv.find((flag) => flag.startsWith('--pid='))?.slice('--pid='.length);
	const modelsArg = process.argv.find((flag) => flag.startsWith('--models='))?.slice('--models='.length);
	if (pidFile) {
		fs.writeFileSync(pidFile, String(process.pid));
	}
	if (flags.has('--exit-on-start')) {
		process.stderr.write('fake agent could not start\n');
		process.exit(1);
	}
	const modelChoices = modelsArg
		? modelsArg.split(',').map((item) => {
				const [value, name = value] = item.split(':');
				return { value, name };
			})
		: [
				{ value: 'sonnet', name: 'Sonnet' },
				{ value: 'opus', name: 'Opus' },
			];
	const allEffortChoices = [
		{ value: 'low', name: 'Low' },
		{ value: 'medium', name: 'Medium' },
		{ value: 'high', name: 'High' },
	];
	const cancels = new Map<string, () => void>();
	let cwd = process.cwd();
	let system = '(none)';
	let sessions = 0;
	let calls = 0;
	let mode = 'auto';
	let model = modelChoices[0].value;
	let effort = 'medium';
	const closed: string[] = [];
	const effortChoices = () =>
		flags.has('--opus-high') && model !== 'opus' ? allEffortChoices.filter((choice) => choice.value !== 'high') : allEffortChoices;
	const configOptions = (): SessionConfigOption[] => {
		if (!flags.has('--options')) {
			return [];
		}
		return [
			{
				id: 'model',
				name: 'Model',
				category: 'model',
				type: 'select',
				currentValue: model,
				options: modelChoices,
			},
			...(flags.has('--no-effort')
				? []
				: [
						{
							id: 'effort',
							name: 'Effort',
							category: 'thought_level' as const,
							type: 'select' as const,
							currentValue: effort,
							options: effortChoices(),
						},
					]),
		];
	};
	const sessionMeta = () => ({
		...(flags.has('--modes') && {
			modes: {
				currentModeId: mode,
				availableModes: [
					{ id: 'default', name: 'Manual' },
					{ id: 'auto', name: 'Auto' },
				],
			},
		}),
		...(flags.has('--options') && { configOptions: configOptions() }),
	});
	const applyConfig = (configId: string, value: string) => {
		if (configId === 'model' && modelChoices.some((choice) => choice.value === value)) {
			model = value;
			if (!effortChoices().some((choice) => choice.value === effort)) {
				effort = 'medium';
			}
			return;
		}
		if (configId === 'effort' && !flags.has('--no-effort') && effortChoices().some((choice) => choice.value === value)) {
			effort = value;
			return;
		}
		throw acp.RequestError.invalidParams(undefined, `unknown option ${configId}=${value}`);
	};
	const open = (
		params: { cwd: string; systemPrompt?: { content: Array<{ type: string; text?: string }> } | null },
		resetDefaults: boolean,
	) => {
		cwd = params.cwd;
		system = params.systemPrompt?.content.map((block) => block.text).join('') ?? '(none)';
		if (resetDefaults) {
			model = modelChoices[0].value;
			effort = 'medium';
		}
	};

	acp
		.agent({ name: 'fake' })
		.onRequest(acp.methods.agent.initialize, async () => {
			if (flags.has('--init-fails')) {
				throw acp.RequestError.internalError(undefined, 'not today');
			}
			if (flags.has('--init-hangs')) {
				await new Promise(() => undefined);
			}
			return {
				protocolVersion: acp.PROTOCOL_VERSION,
				agentCapabilities: {
					sessionCapabilities: {
						...(flags.has('--resume') && { resume: {} }),
						...(flags.has('--system-prompt') && { systemPrompt: {} }),
						...(flags.has('--close') && { close: {} }),
					},
				},
			};
		})
		.onRequest(acp.methods.agent.session.new, ({ params }) => {
			if (flags.has('--auth')) {
				throw acp.RequestError.authRequired();
			}
			open(params, true);
			return { sessionId: `fake-${process.pid}-${++sessions}`, ...sessionMeta() };
		})
		.onRequest(acp.methods.agent.session.setMode, ({ params }) => {
			if (flags.has('--mode-fails')) {
				throw acp.RequestError.internalError(undefined, 'cannot change the mode');
			}
			mode = params.modeId;
			return {};
		})
		.onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
			if ('type' in params) {
				throw acp.RequestError.invalidParams(undefined, 'only select options supported');
			}
			if (flags.has('--slow-set-model') && params.configId === 'model') {
				await new Promise((resolve) => setTimeout(resolve, 80));
			}
			applyConfig(params.configId, params.value);
			return { configOptions: configOptions() };
		})
		.onRequest(acp.methods.agent.session.close, ({ params }) => {
			closed.push(params.sessionId);
			return {};
		})
		.onRequest(acp.methods.agent.session.resume, ({ params }) => {
			if (params.sessionId.startsWith('gone')) {
				throw acp.RequestError.resourceNotFound(params.sessionId);
			}
			open(params, false);
			return sessionMeta();
		})
		.onNotification(acp.methods.agent.session.cancel, ({ params }) => cancels.get(params.sessionId)?.())
		.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
			const { sessionId } = params;
			const blocks = params.prompt.map((block) => (block.type === 'text' ? block.text : ''));
			const update = (sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', text: string) =>
				client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate, content: { type: 'text', text } } });
			const say = async (text: string) => {
				const half = Math.ceil(text.length / 2);
				await update('agent_message_chunk', text.slice(0, half));
				await update('agent_message_chunk', text.slice(half));
			};
			const tool = async (title: string, kind: 'edit' | 'delete', file: string, act: () => void) => {
				const toolCallId = `call-${++calls}`;
				await client.notify(acp.methods.client.session.update, {
					sessionId,
					update: { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', locations: [{ path: file }] },
				});
				act();
				await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' } });
			};
			const ask = async (kind: 'read' | 'edit' | 'execute', title: string, file?: string) => {
				const response = await client.request(acp.methods.client.session.requestPermission, {
					sessionId,
					toolCall: { toolCallId: `call-${++calls}`, title, kind, ...(file && { locations: [{ path: file }] }) },
					options: [
						{ optionId: 'always', name: 'Always allow', kind: 'allow_always' },
						{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
						{ optionId: 'no', name: 'Reject', kind: 'reject_once' },
					],
				});
				return response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled';
			};
			for (const line of blocks.at(-1)!.split('\n')) {
				const [command, first = '', ...rest]: string[] = line.startsWith('[') ? JSON.parse(line) : line.split(' ');
				const text = rest.join(' ');
				const file = path.resolve(cwd, first);
				switch (command) {
					case 'say':
						await say([first, ...rest].join(' '));
						break;
					case 'think':
						await update('agent_thought_chunk', [first, ...rest].join(' '));
						break;
					case 'write':
						await tool(`Write ${first}`, 'edit', file, () => {
							fs.mkdirSync(path.dirname(file), { recursive: true });
							fs.writeFileSync(file, text);
						});
						break;
					case 'delete':
						await tool(`Delete ${first}`, 'delete', file, () => fs.rmSync(file));
						break;
					case 'fswrite':
						await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: file, content: text }).then(
							() => say(`wrote ${first}`),
							(error: Error) => say(`could not write ${first}: ${error.message}`),
						);
						break;
					case 'fsread':
						await client.request(acp.methods.client.fs.readTextFile, { sessionId, path: file }).then(
							(response) => say(`read ${first}: ${response.content}`),
							(error: Error) => say(`could not read ${first}: ${error.message}`),
						);
						break;
					case 'ask': {
						const target = path.resolve(cwd, text);
						const answer = await ask(first as 'read' | 'edit', `${first} ${text}`, target);
						if (answer === 'yes' && first === 'edit') {
							fs.mkdirSync(path.dirname(target), { recursive: true });
							fs.writeFileSync(target, 'asked');
						}
						await say(`answer: ${answer}`);
						break;
					}
					case 'run':
						await say(`answer: ${await ask('execute', [first, ...rest].join(' '))}`);
						break;
					case 'echo':
						await say(blocks.slice(0, -1).join('\n---\n'));
						break;
					case 'system':
						await say(system);
						break;
					case 'session':
						await say(`${sessionId} mode=${mode} closed=${closed.join(',')}`);
						break;
					case 'config':
						await say(`model=${model} effort=${effort}`);
						break;
					case 'setconfig':
						applyConfig(first, text);
						await client.notify(acp.methods.client.session.update, {
							sessionId,
							update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
						});
						break;
					case 'wait':
						await new Promise<void>((resolve) => cancels.set(sessionId, resolve));
						return { stopReason: 'cancelled' as const };
					case 'refuse':
						return { stopReason: 'refusal' as const };
					case 'stderr':
						process.stderr.write(`${[first, ...rest].join(' ')}\n`);
						break;
					case 'exit':
						process.exit(Number(first));
				}
			}
			return { stopReason: 'end_turn' as const };
		})
		.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
}

void main();
