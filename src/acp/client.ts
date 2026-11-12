// The assistant's end of the Agent Client Protocol: starts an agent as a
// child process, speaks ACP with it over its stdin and stdout, and hands on
// what the agent sends and asks for. Nothing of VS Code in here, and no keys:
// the agent uses its own login.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type {
	AgentCapabilities,
	ClientConnection,
	ContentBlock,
	NewSessionRequest,
	RequestPermissionRequest,
	SessionModeState,
	SessionUpdate,
	StopReason,
	SystemPrompt,
} from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };

export type { ContentBlock, RequestPermissionRequest, SessionUpdate, StopReason };

/**
 * The Claude adapter the preset starts. A fixed version, not the latest:
 * the adapter is released often and is still 0.x, `npx` runs whatever the
 * name resolves to with the writer's files in reach, and a fixed version is
 * started from npx's cache without asking the registry.
 */
export const CLAUDE_ADAPTER = '@agentclientprotocol/claude-agent-acp@0.106.0';

export interface AgentCommand {
	command: string;
	args: string[];
	/** The session mode to put the agent in, if it has one by that name: the mode in which it asks before it acts. */
	mode?: string;
}

/** The command that starts the agent the settings choose; undefined when a custom agent is chosen and no command is set. */
export function agentCommand(settings: { agent: string; command: string; args: readonly string[] }): AgentCommand | undefined {
	if (settings.agent !== 'custom') {
		// Claude Code starts in the mode of its own settings, which can be one that decides by itself; `default` asks.
		return { command: 'npx', args: ['-y', CLAUDE_ADAPTER], mode: 'default' };
	}
	return settings.command.trim() ? { command: settings.command.trim(), args: [...settings.args] } : undefined;
}

/**
 * - `not-found`: the command is not on the PATH (no Node.js, or a wrong custom command).
 * - `exited`: the process ended: on start, or in the middle of a session.
 * - `auth`: the agent is not logged in.
 * - `failed`: the agent answered a request with an error.
 */
export type FailureKind = 'not-found' | 'exited' | 'auth' | 'failed';

export class AgentFailure extends Error {
	constructor(
		readonly kind: FailureKind,
		message: string,
		/** The end of what the process wrote to stderr. */
		readonly detail = '',
		/** How the process ended, when it did: its exit code, or the signal that ended it. */
		readonly exit?: string,
	) {
		super(message);
	}
}

export interface AgentHandlers {
	/** Something happened in the session: text, a thought, a tool call… */
	update(update: SessionUpdate): void;
	/** The agent asks before doing something. Resolves to the id of the option chosen, or undefined for none of them. `signal` aborts when the agent no longer waits. */
	permission(request: RequestPermissionRequest, signal: AbortSignal): Promise<string | undefined>;
	/** The text of a file, for agents that read through the client. */
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	/** The process ended though nobody stopped it. */
	closed(failure: AgentFailure): void;
	/** What the process wrote to stderr. */
	log(text: string): void;
}

/** ACP's error code for "log in first". */
const AUTH_REQUIRED = -32000;
const STDERR_KEPT = 2000;

const text = (value: string): ContentBlock => ({ type: 'text', text: value });

export class AgentClient {
	/** What the agent said it can do when the connection was set up. */
	capabilities: AgentCapabilities = {};
	sessionId?: string;
	private connection!: ClientConnection;
	private stderr = '';
	private stopped = false;
	/** While a session is loaded, the agent replays its history; the panel has its own copy. */
	private replaying = false;
	private readonly exited: Promise<AgentFailure>;

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly command: AgentCommand,
		handlers: AgentHandlers,
	) {
		const label = command.command;
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT);
			handlers.log(chunk.trimEnd());
		});
		// Writing to a process that is gone must not take the extension host down with it.
		child.stdin.on('error', () => undefined);
		this.exited = new Promise((resolve) => {
			child.once('error', (error: NodeJS.ErrnoException) =>
				resolve(new AgentFailure(error.code === 'ENOENT' ? 'not-found' : 'exited', `${label}: ${error.message}`)),
			);
			child.once('exit', (code, signal) => resolve(new AgentFailure('exited', `${label} exited (${signal ?? code})`, this.stderr.trim(), String(signal ?? code))));
		});
	}

	/**
	 * Starts the agent in `cwd` and sets up the connection. Rejects with an
	 * `AgentFailure` when the process cannot be started or ends before it
	 * answers; aborting `signal` ends it.
	 */
	static async start(command: AgentCommand, cwd: string, handlers: AgentHandlers, signal?: AbortSignal): Promise<AgentClient> {
		const acp = await import('@agentclientprotocol/sdk');
		// On Windows npx is a .cmd file, which only a shell can run.
		const child = spawn(command.command, command.args, { cwd, shell: process.platform === 'win32' });
		const client = new AgentClient(child, command, handlers);
		const giveUp = () => client.stop();
		signal?.addEventListener('abort', giveUp);
		if (signal?.aborted) {
			giveUp();
		}
		const mine = (sessionId: string) => sessionId === client.sessionId && !client.replaying;
		client.connection = acp
			.client({ name: 'novel-helper' })
			.onNotification(acp.methods.client.session.update, ({ params }) => {
				if (mine(params.sessionId)) {
					handlers.update(params.update);
				}
			})
			.onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
				const optionId = await handlers.permission(params, signal);
				return { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } };
			})
			.onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
				const content = await handlers.readFile(params.path);
				if (params.line === null || params.line === undefined) {
					return { content: params.limit ? content.split('\n').slice(0, params.limit).join('\n') : content };
				}
				const from = params.line - 1;
				return { content: content.split('\n').slice(from, params.limit ? from + params.limit : undefined).join('\n') };
			})
			.onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
				await handlers.writeFile(params.path, params.content);
				return {};
			})
			.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
		// An agent that stopped talking is of no use, whether or not its process is still there.
		void client.connection.closed.then(() => child.kill());
		void client.exited.then((failure) => {
			client.connection.close(failure);
			if (!client.stopped) {
				client.stopped = true;
				handlers.closed(failure);
			}
		});
		const response = await client
			.ask(
				client.connection.agent.request(acp.methods.agent.initialize, {
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
					clientInfo: { name: 'novel-helper', version: '1' },
				}),
			)
			.catch((error: unknown) => {
				// The caller gets no client to stop: a process that answered with an error and lives on is ended here.
				client.stop();
				throw error;
			})
			.finally(() => signal?.removeEventListener('abort', giveUp));
		client.capabilities = response.agentCapabilities ?? {};
		return client;
	}

	/** The answer to a request; an `AgentFailure` instead when the process ends first, the agent is not logged in, or it answers with an error. */
	private async ask<T>(request: Promise<T>): Promise<T> {
		try {
			return await Promise.race([request, this.exited.then((failure) => Promise.reject(failure))]);
		} catch (error) {
			if (error instanceof AgentFailure) {
				throw error;
			}
			// The output of a process that ends closes a moment before its exit is known.
			if (this.connection.signal.aborted) {
				throw await this.exited;
			}
			const { code, message } = error as { code?: number; message?: string };
			throw new AgentFailure(code === AUTH_REQUIRED ? 'auth' : 'failed', message ?? String(error), this.stderr.trim());
		}
	}

	/**
	 * Opens a session in `cwd`: the one called `previous` if the agent can
	 * pick it up again, else a new one. `brief` is what the agent is to know
	 * about the workspace. `briefed` says whether the agent took it as part
	 * of its system prompt; if not, it has to go in front of the first message.
	 * The client has a session only once it is in the mode the command asks
	 * for: when that fails, there is none, and the next call starts over.
	 */
	async open(cwd: string, brief: string, previous?: string): Promise<{ resumed: boolean; briefed: boolean }> {
		const acp = await import('@agentclientprotocol/sdk');
		const session = this.capabilities.sessionCapabilities;
		const systemPrompt: SystemPrompt | undefined = session?.systemPrompt ? { mode: 'append', content: [text(brief)] } : undefined;
		const base: NewSessionRequest = { cwd, mcpServers: [], ...(systemPrompt && { systemPrompt }) };
		const briefed = systemPrompt !== undefined;
		this.sessionId = undefined;
		if (previous !== undefined && (session?.resume || this.capabilities.loadSession)) {
			this.replaying = true;
			try {
				const request = { ...base, sessionId: previous };
				const response = await this.ask(
					session?.resume ? this.connection.agent.request(acp.methods.agent.session.resume, request) : this.connection.agent.request(acp.methods.agent.session.load, request),
				);
				await this.enterMode(previous, response.modes);
				this.sessionId = previous;
				return { resumed: true, briefed: true };
			} catch (error) {
				// A session the agent no longer has is no reason to stop: a new one is opened. Anything else is.
				if (!(error instanceof AgentFailure) || error.kind !== 'failed') {
					throw error;
				}
			} finally {
				this.replaying = false;
			}
		}
		const response = await this.ask(this.connection.agent.request(acp.methods.agent.session.new, base));
		await this.enterMode(response.sessionId, response.modes);
		this.sessionId = response.sessionId;
		return { resumed: false, briefed };
	}

	private async enterMode(sessionId: string, modes: SessionModeState | null | undefined): Promise<void> {
		const mode = this.command.mode;
		if (mode !== undefined && modes && modes.currentModeId !== mode && modes.availableModes.some((available) => available.id === mode)) {
			const acp = await import('@agentclientprotocol/sdk');
			await this.ask(this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode }));
		}
	}

	/** Ends the session, for an agent that can; the process stays for the next one. */
	async close(): Promise<void> {
		const sessionId = this.sessionId;
		this.sessionId = undefined;
		if (sessionId !== undefined && this.capabilities.sessionCapabilities?.close) {
			const acp = await import('@agentclientprotocol/sdk');
			await this.connection.agent.request(acp.methods.agent.session.close, { sessionId }).catch(() => undefined);
		}
	}

	/** Sends a message and resolves when the agent's turn is over. What the agent does meanwhile arrives through the handlers. */
	async prompt(blocks: string[]): Promise<StopReason> {
		const acp = await import('@agentclientprotocol/sdk');
		const response = await this.ask(this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId!, prompt: blocks.map(text) }));
		return response.stopReason;
	}

	/** Asks the agent to stop the turn that is running; `prompt` then resolves with `cancelled`. */
	async cancel(): Promise<void> {
		const acp = await import('@agentclientprotocol/sdk');
		await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId! }).catch(() => undefined);
	}

	/** Ends the process. Closing its stdin first: an agent started through npx may not get the signal, but it does see its input end. */
	stop(): void {
		this.stopped = true;
		this.child.stdin.end();
		this.child.kill();
	}
}
