import { EditorState, Prec, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { paragraphStyle } from '../../core/suggestion';
import { frontmatterLength } from '../../core/text';
const pairs: Record<string, string> = {
	'「': '」',
	'『': '』',
	'（': '）',
	'《': '》',
	'【': '】',
	'“': '”',
	'‘': '’',
	'(': ')',
	'[': ']',
	'{': '}',
	'"': '"',
	"'": "'",
};
const closers = Object.values(pairs);
const jump = (view: EditorView) => {
	const range = view.state.selection.main;
	if (view.composing || !range.empty || !closers.includes(view.state.sliceDoc(range.head, range.head + 1))) {
		return false;
	}
	view.dispatch({ selection: { anchor: range.head + 1 } });
	return true;
};
function lines(state: EditorState): DecorationSet {
	const text = state.doc.toString();
	const frontmatter = frontmatterLength(text);
	const spaced = paragraphStyle(text.slice(frontmatter).split('\n')).separator !== '\n\n';
	const marks = [];
	for (let i = 1; i <= state.doc.lines; i++) {
		const line = state.doc.line(i);
		const classes = [
			line.from < frontmatter ? 'frontmatter' : '',
			/^#{1,6}\s/.test(line.text) ? 'heading' : '',
			spaced && line.text.trim() && line.from >= frontmatter ? 'paragraph' : '',
		]
			.filter(Boolean)
			.join(' ');
		if (classes) {
			marks.push(Decoration.line({ class: classes }).range(line.from));
		}
	}
	return Decoration.set(marks);
}
export const prose: Extension = [
	StateField.define<DecorationSet>({
		create: lines,
		update: (value, tr) => (tr.docChanged ? lines(tr.state) : value),
		provide: (field) => EditorView.decorations.from(field),
	}),
	EditorView.inputHandler.of((view, from, to, text) => {
		if (view.composing || text.length !== 1) {
			return false;
		}
		if (from === to && closers.includes(text) && view.state.sliceDoc(from, from + 1) === text) {
			view.dispatch({ selection: { anchor: from + 1 } });
			return true;
		}
		const right = pairs[text];
		if (!right) {
			return false;
		}
		const selected = view.state.sliceDoc(from, to);
		view.dispatch({
			changes: { from, to, insert: text + selected + right },
			selection: { anchor: from + 1, head: from + 1 + selected.length },
			userEvent: 'input.type',
		});
		return true;
	}),
	Prec.high(
		keymap.of([
			{
				key: 'Tab',
				run: (view) => {
					if (view.composing) {
						return false;
					}
					if (jump(view)) {
						return true;
					}
					view.dispatch(view.state.replaceSelection('\t'), { userEvent: 'input.type' });
					return true;
				},
			},
			{
				key: 'Enter',
				run: (view) => {
					if (view.composing) {
						return false;
					}
					if (jump(view)) {
						return true;
					}
					const line = view.state.doc.lineAt(view.state.selection.main.head);
					const indent = /^\s*/u.exec(line.text)![0];
					view.dispatch(view.state.replaceSelection('\n' + indent), { userEvent: 'input.type' });
					return true;
				},
			},
			{
				key: 'Backspace',
				run: (view) => {
					const range = view.state.selection.main;
					if (view.composing || !range.empty || range.head === 0) {
						return false;
					}
					const before = view.state.sliceDoc(range.head - 1, range.head),
						after = view.state.sliceDoc(range.head, range.head + 1);
					if (!pairs[before] || pairs[before] !== after) {
						return false;
					}
					view.dispatch({
						changes: { from: range.head - 1, to: range.head + 1 },
						selection: { anchor: range.head - 1 },
						userEvent: 'delete.backward',
					});
					return true;
				},
			},
		]),
	),
];
