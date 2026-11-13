/** The continuation lifecycle. No editor, DOM, clock or network dependencies. */
import { LINE_END_REST } from '../../shared/completion';
export interface Position {
	text: string;
	offset: number;
	chapter: boolean;
	prose: boolean;
}
export interface GhostState {
	position: Position;
	enabled: boolean;
	auto: boolean;
	limited: boolean;
	composing: boolean;
	focused: boolean;
	serial: number;
	pending?: number;
	ghost: string;
	cached?: { key: string; text: string };
}
export type GhostEvent =
	| { type: 'type' | 'move' | 'compositionEnd'; position: Position }
	| { type: 'compositionStart' | 'timeout' | 'manual' | 'tab' | 'sentence' | 'escape' | 'blur' | 'focus' }
	| { type: 'answer'; id: number; text: string }
	| { type: 'failure'; id: number }
	| { type: 'settings'; enabled: boolean; auto: boolean; limited: boolean; invalidate?: boolean };
export type GhostAction =
	| { type: 'timer' | 'clearTimer' | 'hide' }
	| { type: 'request'; id: number; position: Position; manual: boolean }
	| { type: 'abort'; id: number }
	| { type: 'show' | 'insert'; text: string };
export function initialGhost(position: Position): GhostState {
	return { position, enabled: true, auto: true, limited: false, composing: false, focused: false, serial: 0, ghost: '' };
}
const keyOf = (p: Position) => JSON.stringify([p.text, p.offset]);
export function firstSentence(text: string): string {
	const end = /[。！？…][。！？…」』”’）)】》〉"']*/.exec(text);
	return end ? text.slice(0, end.index + end[0].length) : text;
}
export function transition(current: GhostState, event: GhostEvent): { state: GhostState; actions: GhostAction[] } {
	const state = { ...current };
	const actions: GhostAction[] = [];
	const discard = () => {
		actions.push({ type: 'clearTimer' });
		if (state.pending !== undefined) {
			actions.push({ type: 'abort', id: state.pending });
			state.pending = undefined;
		}
		if (state.ghost) {
			actions.push({ type: 'hide' });
			state.ghost = '';
		}
	};
	const eligible = () =>
		state.enabled &&
		state.focused &&
		state.auto &&
		!state.limited &&
		state.position.chapter &&
		state.position.prose &&
		LINE_END_REST.test(state.position.text.slice(state.position.offset).split('\n', 1)[0]);
	const schedule = () => {
		if (eligible()) {
			actions.push({ type: 'timer' });
		}
	};
	if (event.type === 'settings') {
		if (event.invalidate) {
			discard();
			state.cached = undefined;
		}
		Object.assign(state, { enabled: event.enabled, auto: event.auto, limited: event.limited });
		if (!state.enabled || !state.auto || state.limited) {
			discard();
		} else if (!state.composing) {
			schedule();
		}
		return { state, actions };
	}
	if (state.composing && !['compositionEnd', 'blur'].includes(event.type)) {
		return { state, actions };
	}
	switch (event.type) {
		case 'compositionStart':
			discard();
			state.composing = true;
			break;
		case 'compositionEnd': {
			state.composing = false;
			state.position = event.position;
			if (state.enabled && state.focused && state.cached?.key === keyOf(event.position)) {
				state.ghost = state.cached.text;
				actions.push({ type: 'show', text: state.ghost });
			} else {
				schedule();
			}
			break;
		}
		case 'type':
		case 'move':
			discard();
			state.position = event.position;
			schedule();
			break;
		case 'focus':
			state.focused = true;
			schedule();
			break;
		case 'blur':
			discard();
			state.focused = false;
			state.composing = false;
			break;
		case 'timeout':
		case 'manual': {
			const manual = event.type === 'manual';
			if (!state.enabled || !state.focused || !state.position.prose || (!manual && !eligible())) {
				break;
			}
			discard();
			if (!manual && state.cached?.key === keyOf(state.position)) {
				state.ghost = state.cached.text;
				actions.push({ type: 'show', text: state.ghost });
			} else {
				state.pending = ++state.serial;
				actions.push({ type: 'request', id: state.pending, position: state.position, manual });
			}
			break;
		}
		case 'answer':
			if (event.id !== state.pending || !state.enabled || !state.focused) {
				break;
			}
			state.ghost = event.text;
			state.cached = { key: keyOf(state.position), text: event.text };
			// Keep the request cancellable while the provider finishes reporting usage.
			if (event.text) {
				actions.push({ type: 'show', text: event.text });
			}
			break;
		case 'failure':
			if (event.id === state.pending) {
				state.pending = undefined;
			}
			break;
		case 'escape':
			discard();
			break;
		case 'tab':
		case 'sentence': {
			if (!state.ghost) {
				break;
			}
			const text = event.type === 'sentence' ? firstSentence(state.ghost) : state.ghost;
			const rest = state.ghost.slice(text.length);
			discard();
			actions.push({ type: 'insert', text });
			const { position } = state;
			state.position = {
				...position,
				text: position.text.slice(0, position.offset) + text + position.text.slice(position.offset),
				offset: position.offset + text.length,
			};
			state.ghost = rest;
			state.cached = rest ? { key: keyOf(state.position), text: rest } : undefined;
			if (rest) {
				actions.push({ type: 'show', text: rest });
			}
			break;
		}
	}
	return { state, actions };
}
