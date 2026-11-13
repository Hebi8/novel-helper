import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Settings } from '../../shared/defaults';
/** Live preferences belong to each view; document state and undo remain untouched. */
export function writingPreferences(initial: Settings) {
	return ViewPlugin.fromClass(
		class {
			settings = initial;
			off: () => void;
			frame?: number;
			revision = 0;
			disposed = false;
			constructor(readonly view: EditorView) {
				this.apply();
				this.off = window.novel.settings.onChanged((settings) => {
					this.revision++;
					this.settings = settings;
					this.apply();
				});
				void window.novel.settings.get().then((settings) => {
					if (!this.disposed && this.revision === 0) {
						this.settings = settings;
						this.apply();
					}
				});
			}
			apply() {
				this.view.dom.style.setProperty('--writing-font', this.settings['editor.fontFamily']);
				this.view.dom.style.setProperty('--writing-size', `${this.settings['editor.fontSize']}px`);
				this.view.dom.classList.toggle('center-line', this.settings['editor.centerLine']);
				this.view.requestMeasure();
			}
			update(update: ViewUpdate) {
				if (
					!this.settings['editor.centerLine'] ||
					!this.view.hasFocus ||
					this.view.compositionStarted ||
					!(update.docChanged || update.selectionSet)
				) {
					return;
				}
				cancelAnimationFrame(this.frame ?? 0);
				this.frame = requestAnimationFrame(() => {
					this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'center' }) });
				});
			}
			destroy() {
				this.disposed = true;
				this.off();
				cancelAnimationFrame(this.frame ?? 0);
			}
		},
	);
}
