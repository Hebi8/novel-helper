import { Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, showTooltip, type DecorationSet, type Tooltip } from '@codemirror/view';
import { createRoot } from 'react-dom/client';
import type { OpenOptions } from '../../shared/api';
import type { LoreEntry } from '../../core/library';
import { LoreCard } from './LoreCard';
import { VisibleLore } from './matches';
export const updateLore = StateEffect.define<readonly LoreEntry[]>();
interface Card {
	from: number;
	to: number;
	ids: string[];
	source: 'hover' | 'keyboard';
}
export function loreExtension(entries: readonly LoreEntry[], open: (path: string, options?: OpenOptions) => Promise<void>) {
	const catalog = StateField.define<VisibleLore>({
		create: () => new VisibleLore(entries),
		update: (value, transaction) => {
			for (const effect of transaction.effects) {
				if (effect.is(updateLore)) {
					return new VisibleLore(effect.value);
				}
			}
			return value;
		},
	});
	const setCard = StateEffect.define<Card | null>();
	const card = StateField.define<Card | null>({
		create: () => null,
		update: (value, transaction) => {
			for (const effect of transaction.effects) {
				if (effect.is(setCard)) {
					return effect.value;
				}
				if (effect.is(updateLore) && value) {
					const ids = value.ids.filter((id) => effect.value.some((entry) => entry.id === id));
					return ids.length ? { ...value, ids } : null;
				}
			}
			return transaction.docChanged || transaction.selection ? null : value;
		},
	});
	const close = (view: EditorView, focus = false) => {
		view.dispatch({ effects: setCard.of(null) });
		if (focus) {
			view.focus();
		}
	};
	const at = (view: EditorView, position: number) => {
		const line = view.state.doc.lineAt(position);
		const match = view.state.field(catalog).matcher.at(line.text, position - line.from);
		return match && { ...match, start: match.start + line.from, end: match.end + line.from };
	};
	const show = (view: EditorView, position: number, source: Card['source']) => {
		const match = at(view, position);
		if (match) {
			view.dispatch({ effects: setCard.of({ from: match.start, to: match.end, ids: match.ids, source }) });
		}
		return true;
	};
	const openCard = (view: EditorView, beside: boolean) => {
		const id = view.state.field(card)?.ids[0];
		if (!id) {
			return false;
		}
		close(view, true);
		void open(id, { beside });
		return true;
	};
	const openAt = (view: EditorView, beside: boolean, position = view.state.selection.main.head) => {
		const match = at(view, position);
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
			view.state
				.field(catalog)
				.find(view.state.doc, view.visibleRanges)
				.map((match) => Decoration.mark({ class: 'lore-name' }).range(match.start, match.end)),
			true,
		);
	const hover = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			timer?: ReturnType<typeof setTimeout>;
			element?: Element;
			outside = (event: PointerEvent) => {
				if (!this.view.dom.contains(event.target as Node)) {
					this.stop();
					if (this.view.state.field(card)) {
						close(this.view);
					}
				}
			};
			constructor(readonly view: EditorView) {
				this.decorations = marks(view);
				document.addEventListener('pointerdown', this.outside);
				view.dom.addEventListener('mousemove', this.move);
				view.dom.addEventListener('mouseleave', this.leave);
				view.dom.addEventListener('focusout', this.loseFocus);
			}
			update(update: import('@codemirror/view').ViewUpdate) {
				if (update.docChanged || update.viewportChanged || update.startState.field(catalog) !== update.state.field(catalog)) {
					this.decorations = marks(update.view);
				}
				if (
					update.docChanged ||
					update.startState.field(catalog) !== update.state.field(catalog) ||
					update.state.field(card)?.source === 'keyboard'
				) {
					this.stop();
				}
			}
			stop() {
				clearTimeout(this.timer);
				this.element = undefined;
			}
			move = (event: MouseEvent) => {
				if (this.view.state.field(card)?.source === 'keyboard') {
					return;
				}
				const target = event.target as Element;
				const element = target.closest('.lore-name');
				if (element === this.element) {
					return;
				}
				this.stop();
				if (element && this.view.contentDOM.contains(element)) {
					this.element = element;
					this.timer = setTimeout(() => show(this.view, this.view.posAtDOM(element), 'hover'), 400);
				} else if (!target.closest('.lore-tooltip') && this.view.state.field(card)?.source === 'hover') {
					this.timer = setTimeout(() => {
						if (this.view.state.field(card)?.source === 'hover') {
							close(this.view);
						}
					}, 400);
				}
			};
			leave = () => {
				this.stop();
				if (this.view.state.field(card)?.source === 'hover') {
					close(this.view);
				}
			};
			loseFocus = (event: FocusEvent) => {
				if (!this.view.dom.contains(event.relatedTarget as Node | null)) {
					this.stop();
					if (this.view.state.field(card)) {
						close(this.view);
					}
				}
			};
			destroy() {
				this.stop();
				document.removeEventListener('pointerdown', this.outside);
				this.view.dom.removeEventListener('mousemove', this.move);
				this.view.dom.removeEventListener('mouseleave', this.leave);
				this.view.dom.removeEventListener('focusout', this.loseFocus);
			}
		},
		{
			decorations: (plugin) => plugin.decorations,
		},
	);
	return [
		catalog,
		card,
		hover,
		showTooltip.compute([card, catalog], (state): Tooltip | null => {
			const current = state.field(card);
			if (!current) {
				return null;
			}
			const byId = new Map(state.field(catalog).entries.map((entry) => [entry.id, entry]));
			return {
				pos: current.from,
				end: current.to,
				above: true,
				create: (view) => {
					const dom = document.createElement('div');
					dom.className = 'lore-tooltip';
					const root = createRoot(dom);
					root.render(
						<>
							{current.ids.map((id) => (
								<LoreCard
									key={id}
									entry={byId.get(id)!}
									open={() => {
										close(view, true);
										void open(id);
									}}
								/>
							))}
						</>,
					);
					dom.addEventListener('keydown', (event) => {
						if (event.key === 'Escape' && !event.isComposing) {
							event.preventDefault();
							close(view, true);
						}
						if (event.metaKey && event.key === 'Enter') {
							event.preventDefault();
							openCard(view, event.altKey);
						}
					});
					return { dom, destroy: () => root.unmount() };
				},
			};
		}),
		Prec.highest(
			keymap.of([
				{ key: 'Mod-i', run: (view) => show(view, view.state.selection.main.head, 'keyboard') },
				{ key: 'Mod-k Mod-i', run: (view) => show(view, view.state.selection.main.head, 'keyboard') },
				{ key: 'F12', run: (view) => openAt(view, false) },
				{ key: 'Alt-F12', run: (view) => openAt(view, true) },
				{ key: 'Mod-Enter', run: (view) => openCard(view, false) },
				{ key: 'Alt-Mod-Enter', run: (view) => openCard(view, true) },
				{
					key: 'Escape',
					run: (view) => {
						if (!view.state.field(card)) {
							return false;
						}
						close(view, true);
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
				const element = (event.target as Element).closest('.lore-name');
				if (!element) {
					return false;
				}
				event.preventDefault();
				return openAt(view, event.altKey, view.posAtDOM(element));
			},
		}),
	];
}
