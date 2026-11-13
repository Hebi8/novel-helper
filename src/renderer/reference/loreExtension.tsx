import { Prec, StateEffect, StateField } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	hoverTooltip,
	closeHoverTooltips,
	keymap,
	showTooltip,
	type DecorationSet,
	type Tooltip,
} from '@codemirror/view';
import { createRoot } from 'react-dom/client';
import type { OpenOptions } from '../../shared/api';
import type { LoreEntry } from '../../core/library';
import { LoreCard } from './LoreCard';
import { VisibleLore } from './matches';
export function loreExtension(entries: readonly LoreEntry[], open: (path: string, options?: OpenOptions) => Promise<void>) {
	const lore = new VisibleLore(entries);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let cardIds: string[] = [];
	const setCard = StateEffect.define<Tooltip | null>();
	const card = StateField.define<Tooltip | null>({
		create: () => null,
		update: (value, transaction) => {
			for (const effect of transaction.effects) {
				if (effect.is(setCard)) {
					return effect.value;
				}
			}
			return transaction.docChanged || transaction.selection ? null : value;
		},
		provide: (field) => showTooltip.from(field),
	});
	const close = (view: EditorView) => {
		view.dispatch({ effects: closeHoverTooltips });
		view.dispatch({ effects: setCard.of(null) });
		cardIds = [];
		view.focus();
	};
	const at = (view: EditorView, position: number) => {
		const line = view.state.doc.lineAt(position);
		const match = lore.matcher.at(line.text, position - line.from);
		return match && { ...match, start: match.start + line.from, end: match.end + line.from };
	};
	const tip = (view: EditorView, position: number): Tooltip | null => {
		const match = at(view, position);
		if (!match) {
			return null;
		}
		return {
			pos: match.start,
			end: match.end,
			above: true,
			create: () => {
				cardIds = match.ids;
				const dom = document.createElement('div');
				dom.className = 'lore-tooltip';
				const root = createRoot(dom);
				const openCard = (id: string, beside = false) => {
					close(view);
					open(id, { beside });
				};
				root.render(
					<>
						{match.ids.map((id) => (
							<LoreCard key={id} entry={byId.get(id)!} open={() => openCard(id)} />
						))}
					</>,
				);
				dom.addEventListener('keydown', (event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						close(view);
					}
					if (event.metaKey && event.key === 'Enter') {
						event.preventDefault();
						openCard(match.ids[0], event.altKey);
					}
				});
				return {
					dom,
					destroy: () => {
						root.unmount();
						cardIds = [];
					},
				};
			},
		};
	};
	const show = (view: EditorView) => {
		const tooltip = tip(view, view.state.selection.main.head);
		if (!tooltip) {
			return false;
		}
		view.dispatch({ effects: closeHoverTooltips });
		view.dispatch({ effects: setCard.of(tooltip) });
		return true;
	};
	const openAt = (view: EditorView, beside: boolean) => {
		const match = at(view, view.state.selection.main.head);
		if (!match) {
			return false;
		}
		void (async () => {
			for (const id of match.ids) {
				await open(id, { beside });
			}
		})();
		return true;
	};
	const marks = (view: EditorView) =>
		Decoration.set(
			lore.find(view.state.doc, view.visibleRanges).map((match) => Decoration.mark({ class: 'lore-name' }).range(match.start, match.end)),
			true,
		);
	return [
		card,
		ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = marks(view);
				}
				update(update: import('@codemirror/view').ViewUpdate) {
					if (update.docChanged || update.viewportChanged) {
						this.decorations = marks(update.view);
					}
				}
			},
			{ decorations: (plugin) => plugin.decorations },
		),
		hoverTooltip((view, position) => tip(view, position), { hoverTime: 400 }),
		Prec.highest(
			keymap.of([
				{ key: 'Mod-i', run: show },
				{ key: 'Mod-k Mod-i', run: show },
				{ key: 'F12', run: (view) => openAt(view, false) },
				{ key: 'Alt-F12', run: (view) => openAt(view, true) },
				{
					key: 'Mod-Enter',
					run: (view) => {
						const id = cardIds[0];
						if (!id) {
							return false;
						}
						close(view);
						open(id);
						return true;
					},
				},
				{
					key: 'Alt-Mod-Enter',
					run: (view) => {
						const id = cardIds[0];
						if (!id) {
							return false;
						}
						close(view);
						open(id, { beside: true });
						return true;
					},
				},
				{
					key: 'Escape',
					run: (view) => {
						if (!cardIds.length) {
							return false;
						}
						close(view);
						return true;
					},
				},
			]),
		),
		EditorView.domEventHandlers({
			mousedown: (event, view) => {
				if (!event.metaKey) {
					return false;
				}
				const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
				const match = position === null ? undefined : at(view, position);
				if (!match) {
					return false;
				}
				event.preventDefault();
				void (async () => {
					for (const id of match.ids) {
						await open(id, { beside: event.altKey });
					}
				})();
				return true;
			},
		}),
	];
}
