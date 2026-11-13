import type { AssistantEvent, AssistantState } from '../../shared/assistant';

export function applyAssistantEvent(state: AssistantState, event: AssistantEvent): AssistantState {
	switch (event.type) {
		case 'state':
			return event.state;
		case 'status':
			return { ...state, busy: event.busy, status: event.status };
		case 'item': {
			const items = state.items.slice();
			items[event.index] = event.item;
			return { ...state, items };
		}
	}
}
