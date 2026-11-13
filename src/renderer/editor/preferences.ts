import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
export function shouldCenter(update: Pick<ViewUpdate, 'docChanged' | 'selectionSet' | 'transactions'>): boolean {
	return (
		(update.docChanged || update.selectionSet) && !update.transactions.some((transaction) => transaction.isUserEvent('select.pointer'))
	);
}
export function writingPreferences(enabled: () => boolean) {
	return ViewPlugin.fromClass(
		class {
			frame?: number;
			constructor(readonly view: EditorView) {}
			update(update: ViewUpdate) {
				cancelAnimationFrame(this.frame ?? 0);
				if (!enabled() || !this.view.hasFocus || this.view.compositionStarted || !shouldCenter(update)) {
					return;
				}
				this.frame = requestAnimationFrame(() =>
					this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'center' }) }),
				);
			}
			destroy() {
				cancelAnimationFrame(this.frame ?? 0);
			}
		},
	);
}
