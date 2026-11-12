// What the assistant's panel shows: the messages, thoughts, tool calls and
// questions of a conversation, in order, and after each turn what it changed.
// The agent's stream of session updates is folded into this list.

import type { SessionUpdate } from '../acp/client';
import { pathsOf } from './permission';
import type { Change } from './snapshot';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'stopped';

/** One way to answer a question of the agent. `kind` is ACP's: allow_once, allow_always, reject_once, reject_always. */
export interface AskOption {
	id: string;
	name: string;
	kind: string;
}

export type Item =
	/** What the writer sent; `context` names what the editor added to it. */
	| { kind: 'user'; text: string; context?: string }
	| { kind: 'agent'; text: string }
	| { kind: 'thought'; text: string }
	| { kind: 'tool'; id: string; title: string; tool?: string; status: ToolStatus; paths: string[] }
	| { kind: 'plan'; entries: Array<{ content: string; status: string }> }
	/** The agent asks before doing something. `answer` is the name of the option chosen; `closed` without an answer: nobody is waiting any more. */
	| { kind: 'ask'; id: string; title: string; detail: string; options: AskOption[]; answer?: string; closed?: boolean }
	/**
	 * The end of a turn, or a going back. `record` is the snapshot to go back
	 * to; missing when nothing was changed. `stop` is ACP's stop reason,
	 * `failed` when the turn broke off, or `reverted`, with `target` the
	 * record gone back to.
	 */
	| { kind: 'turn'; record?: number; stop: string; changes: Change[]; target?: number }
	| { kind: 'notice'; level: 'info' | 'error'; text: string; detail?: string };

/** No more items than this are kept from one window to the next. */
const KEPT_ITEMS = 300;

export class Transcript {
	constructor(readonly items: Item[] = []) {}

	/** Adds an item and returns where it is. */
	push(item: Item): number {
		return this.items.push(item) - 1;
	}

	private last<K extends Item['kind']>(kind: K, matches: (item: Extract<Item, { kind: K }>) => boolean = () => true): number {
		for (let i = this.items.length - 1; i >= 0; i--) {
			const item = this.items[i];
			if (item.kind === kind && matches(item as Extract<Item, { kind: K }>)) {
				return i;
			}
		}
		return -1;
	}

	private append(kind: 'agent' | 'thought', text: string): number {
		const end = this.items.at(-1);
		if (end?.kind === kind) {
			end.text += text;
			return this.items.length - 1;
		}
		return this.push({ kind, text });
	}

	/**
	 * Takes in an update of the session. Returns where the item is that was
	 * added or changed, or undefined for an update the panel shows nothing of.
	 * `name` turns a path the agent gave into how it is shown.
	 */
	apply(update: SessionUpdate, name: (path: string) => string = (path) => path): number | undefined {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
			case 'agent_thought_chunk':
				return update.content.type === 'text' && update.content.text
					? this.append(update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought', update.content.text)
					: undefined;
			case 'tool_call':
			case 'tool_call_update': {
				const paths = pathsOf(update).map(name);
				const at = this.last('tool', (item) => item.id === update.toolCallId);
				if (at < 0) {
					return this.push({ kind: 'tool', id: update.toolCallId, title: update.title ?? '', tool: update.kind ?? undefined, status: update.status ?? 'pending', paths });
				}
				// An update carries only what changed.
				const item = this.items[at] as Extract<Item, { kind: 'tool' }>;
				item.title = update.title ?? item.title;
				item.tool = update.kind ?? item.tool;
				item.status = update.status ?? item.status;
				item.paths = paths.length ? paths : item.paths;
				return at;
			}
			case 'plan': {
				const entries = update.entries.map(({ content, status }) => ({ content, status }));
				// One plan a turn: a later one replaces it.
				const at = this.last('plan');
				if (at > this.last('user')) {
					this.items[at] = { kind: 'plan', entries };
					return at;
				}
				return this.push({ kind: 'plan', entries });
			}
			default:
				return undefined;
		}
	}

	/** The question with this id. */
	ask(id: string): Extract<Item, { kind: 'ask' }> | undefined {
		return this.items[this.last('ask', (item) => item.id === id)] as Extract<Item, { kind: 'ask' }> | undefined;
	}

	/**
	 * Ends the turn that is running: tool calls that were never finished are
	 * marked as stopped and open questions as closed, then the turn's item is
	 * added. Returns where the changed items are.
	 */
	endTurn(turn: Extract<Item, { kind: 'turn' }>): number[] {
		const changed: number[] = [];
		for (let i = this.items.length - 1; i >= 0 && this.items[i].kind !== 'user'; i--) {
			const item = this.items[i];
			if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
				item.status = 'stopped';
				changed.push(i);
			} else if (item.kind === 'ask' && item.answer === undefined && !item.closed) {
				item.closed = true;
				changed.push(i);
			}
		}
		return [...changed, this.push(turn)];
	}

	/** What is kept for the next window: the end of the list. */
	kept(): Item[] {
		return this.items.slice(-KEPT_ITEMS);
	}
}
