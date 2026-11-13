import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
export class CenterLine {
	private frame?: number;
	constructor(
		private readonly view: EditorView,
		private readonly enabled: () => boolean,
	) {}
	update(update: ViewUpdate) {
		if (update.transactions.some((transaction) => transaction.isUserEvent('select.pointer'))) {
			cancelAnimationFrame(this.frame ?? 0);
			this.frame = undefined;
			return;
		}
		if (!this.enabled() || !this.view.hasFocus || this.view.compositionStarted || !(update.docChanged || update.selectionSet)) {
			return;
		}
		this.frame ??= requestAnimationFrame(() => {
			this.frame = undefined;
			this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'center' }) });
		});
	}
	destroy() {
		cancelAnimationFrame(this.frame ?? 0);
	}
}
export function writingPreferences(enabled: () => boolean) {
	return ViewPlugin.define((view) => new CenterLine(view, enabled));
}
