// The page of the assistant's panel. It holds no state of its own beyond the
// draft in the input box: the extension sends the list of items and every
// change to it, and this file turns them into elements. Everything the agent
// wrote gets in as text nodes; there is no innerHTML here.

import { type Block, type Inline, parseMarkdown } from '../core/markdown';
import type { Item } from '../core/transcript';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

type FromHost =
	| { type: 'init'; strings: Record<string, string>; items: Item[]; busy: boolean; status: string }
	| { type: 'item'; index: number; item: Item }
	| { type: 'state'; busy: boolean; status: string }
	| { type: 'context'; text: string }
	| { type: 'draft'; text: string };

const host = acquireVsCodeApi();
const log = document.getElementById('log')!;
const status = document.getElementById('status')!;
const context = document.getElementById('context')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const send = document.getElementById('send') as HTMLButtonElement;
const stop = document.getElementById('stop') as HTMLButtonElement;

let strings: Record<string, string> = {};
let items: Item[] = [];
let busy = false;
/** Items that changed since the last frame; text that streams in is drawn once a frame, not once a chunk. */
const stale = new Set<number>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const made = document.createElement(tag);
	made.className = className;
	made.textContent = text;
	return made;
}

const fill = (text: string, ...values: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(values[Number(i)]));

function inline(parent: HTMLElement, pieces: Inline[]): void {
	for (const piece of pieces) {
		if (typeof piece === 'string') {
			parent.append(piece);
		} else if (piece.type === 'code') {
			parent.append(element('code', '', piece.text));
		} else if (piece.type === 'link') {
			const link = element('a');
			link.href = piece.href;
			link.title = piece.href;
			link.addEventListener('click', (event) => {
				event.preventDefault();
				host.postMessage({ type: 'link', href: piece.href });
			});
			inline(link, piece.children);
			parent.append(link);
		} else {
			const made = element(piece.type);
			inline(made, piece.children);
			parent.append(made);
		}
	}
}

function blocks(parent: HTMLElement, list: Block[]): void {
	for (const block of list) {
		switch (block.type) {
			case 'paragraph': {
				const made = element('p');
				inline(made, block.children);
				parent.append(made);
				break;
			}
			case 'heading': {
				const made = element(`h${Math.min(block.level + 2, 6)}` as 'h3');
				inline(made, block.children);
				parent.append(made);
				break;
			}
			case 'code': {
				const made = element('pre');
				made.append(element('code', '', block.text));
				parent.append(made);
				break;
			}
			case 'quote': {
				const made = element('blockquote');
				blocks(made, block.children);
				parent.append(made);
				break;
			}
			case 'list': {
				const made = element(block.ordered ? 'ol' : 'ul');
				if (block.ordered) {
					(made as HTMLOListElement).start = block.start;
				}
				for (const item of block.items) {
					const li = element('li');
					blocks(li, item);
					made.append(li);
				}
				parent.append(made);
				break;
			}
			case 'table': {
				const made = element('table');
				const row = (cells: Inline[][], tag: 'th' | 'td') => {
					const tr = element('tr');
					for (const cell of cells) {
						const made = element(tag);
						inline(made, cell);
						tr.append(made);
					}
					return tr;
				};
				made.append(row(block.head, 'th'), ...block.rows.map((cells) => row(cells, 'td')));
				parent.append(made);
				break;
			}
			case 'rule':
				parent.append(element('hr'));
		}
	}
}

function button(label: string, className: string, message: Record<string, unknown>): HTMLButtonElement {
	const made = element('button', className, label);
	made.addEventListener('click', () => host.postMessage(message));
	return made;
}

function render(item: Item, was?: Element): HTMLElement {
	switch (item.kind) {
		case 'user': {
			const made = element('div', 'item user');
			made.append(element('div', 'text', item.text));
			if (item.context) {
				made.append(element('div', 'with', item.context));
			}
			return made;
		}
		case 'agent': {
			const made = element('div', 'item agent');
			blocks(made, parseMarkdown(item.text));
			return made;
		}
		case 'thought': {
			const made = element('details', 'item thought');
			// Folded unless the writer unfolded it; it stays so while more of it comes in.
			made.open = was instanceof HTMLDetailsElement && was.open;
			made.append(element('summary', '', strings.thought), element('div', 'text', item.text));
			return made;
		}
		case 'tool': {
			const made = element('div', `item tool ${item.status}`);
			made.title = item.paths.join('\n');
			made.append(element('span', 'title', item.title), element('span', 'state', strings[item.status]));
			return made;
		}
		case 'plan': {
			const made = element('div', 'item plan');
			made.append(element('div', 'label', strings.plan));
			const list = element('ul');
			for (const entry of item.entries) {
				list.append(element('li', entry.status, entry.content));
			}
			made.append(list);
			return made;
		}
		case 'ask': {
			const made = element('div', item.answer !== undefined || item.closed ? 'item ask settled' : 'item ask');
			made.append(element('div', 'title', item.title));
			if (item.detail) {
				made.append(element('pre', 'detail', item.detail));
			}
			if (item.answer !== undefined) {
				made.append(element('div', 'outcome', fill(strings.askAnswered, item.answer)));
			} else if (item.closed) {
				made.append(element('div', 'outcome', strings.askClosed));
			} else {
				const row = element('div', 'row');
				for (const option of item.options) {
					row.append(button(option.name, option.kind.startsWith('allow') ? '' : 'secondary', { type: 'answer', id: item.id, option: option.id }));
				}
				made.append(row);
			}
			return made;
		}
		case 'turn': {
			const made = element('div', 'item turn');
			const reverted = item.stop === 'reverted';
			const about = reverted ? fill(strings.reverted, item.target ?? '?') : item.stop === 'end_turn' ? '' : (strings[item.stop === 'failed' ? 'failedTurn' : item.stop] ?? item.stop);
			if (about) {
				made.append(element('div', 'about', about));
			}
			made.append(element('div', 'label', item.changes.length ? fill(strings.changed, item.changes.length) : strings.unchanged));
			if (item.changes.length && item.record !== undefined) {
				const list = element('ul');
				for (const change of item.changes) {
					const kind = change.before === undefined ? 'added' : change.after === undefined ? 'removed' : 'modified';
					const li = element('li', kind);
					li.append(element('span', 'kind', strings[kind]), button(change.path, 'link', { type: 'diff', record: item.record, path: change.path }));
					list.append(li);
				}
				made.append(list, button(reverted ? strings.undoRevert : strings.revert, 'secondary', { type: 'revert', record: item.record }));
			}
			return made;
		}
		case 'notice': {
			const made = element('div', `item notice ${item.level}`);
			made.append(element('div', 'text', item.text));
			if (item.detail) {
				made.append(element('pre', 'detail', item.detail));
			}
			return made;
		}
	}
}

/** Whether the end of the list is in view: only then does new text pull the view along. */
const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;

function draw(index: number): void {
	const was = log.children[index];
	const made = render(items[index], was);
	if (was) {
		was.replaceWith(made);
	} else {
		log.append(made);
	}
}

function drawAll(): void {
	log.replaceChildren();
	if (items.length === 0) {
		log.append(element('div', 'empty', strings.empty));
	}
	items.forEach((_, index) => draw(index));
	log.scrollTop = log.scrollHeight;
}

function showState(): void {
	send.disabled = busy || input.value.trim() === '';
	stop.hidden = !busy;
}

function submit(): void {
	const text = input.value.trim();
	if (text && !busy) {
		host.postMessage({ type: 'send', text });
		input.value = '';
		host.setState({ draft: '' });
		showState();
	}
}

window.addEventListener('message', (event: MessageEvent<FromHost>) => {
	const message = event.data;
	switch (message.type) {
		case 'init':
			({ strings, items, busy } = message);
			input.placeholder = strings.placeholder;
			send.textContent = strings.send;
			stop.textContent = strings.stop;
			status.textContent = message.status;
			status.hidden = !message.status;
			drawAll();
			showState();
			break;
		case 'item':
			if (items.length === 0) {
				log.replaceChildren();
			}
			items[message.index] = message.item;
			if (stale.size === 0) {
				requestAnimationFrame(() => {
					const follow = atEnd();
					[...stale].sort((a, b) => a - b).forEach(draw);
					stale.clear();
					if (follow) {
						log.scrollTop = log.scrollHeight;
					}
				});
			}
			stale.add(message.index);
			break;
		case 'state':
			busy = message.busy;
			status.textContent = message.status;
			status.hidden = !message.status;
			showState();
			break;
		case 'context':
			context.textContent = message.text;
			context.hidden = !message.text;
			break;
		case 'draft':
			input.value = message.text;
			host.setState({ draft: message.text });
			showState();
			break;
	}
});

input.addEventListener('input', () => {
	host.setState({ draft: input.value });
	showState();
});
input.addEventListener('keydown', (event) => {
	// Enter while an input method is still composing (picking a Chinese word) belongs to the input method.
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		submit();
	}
});
send.addEventListener('click', submit);
stop.addEventListener('click', () => host.postMessage({ type: 'stop' }));

input.value = (host.getState() as { draft?: string } | undefined)?.draft ?? '';
host.postMessage({ type: 'ready' });
