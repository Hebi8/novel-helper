import { EditorState, Prec, StateField, type Extension, type Range } from '@codemirror/state';
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
const HEADING_PREFIX = /^(#{1,6})([ \t]+)/;

export interface ProseOptions {
	chapter?: boolean;
	autoPair?: () => boolean;
}

const jump = (view: EditorView) => {
	const range = view.state.selection.main;
	if (view.compositionStarted || !range.empty || !closers.includes(view.state.sliceDoc(range.head, range.head + 1))) {
		return false;
	}
	view.dispatch({ selection: { anchor: range.head + 1 }, userEvent: 'select' });
	return true;
};

function plainLines(state: EditorState): DecorationSet {
	const text = state.doc.toString();
	const frontmatter = frontmatterLength(text);
	const spaced = paragraphStyle(text.slice(frontmatter).split('\n')).separator !== '\n\n';
	const marks: Range<Decoration>[] = [];
	for (let i = 1; i <= state.doc.lines; i++) {
		const line = state.doc.line(i);
		const classes = [
			!spaced && !line.text.trim() ? 'blank-paragraph' : '',
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

function activeLineRange(state: EditorState, frontmatter: number, spaced: boolean): [number, number] {
	const main = state.selection.main;
	let start = state.doc.lineAt(main.from).number;
	let end = state.doc.lineAt(main.to).number;
	if (!spaced && start === end) {
		const current = state.doc.line(start);
		const isProse = current.from >= frontmatter && current.text.trim().length > 0 && !HEADING_PREFIX.test(current.text);
		if (isProse) {
			while (start > 1) {
				const prev = state.doc.line(start - 1);
				if (prev.from < frontmatter || !prev.text.trim() || HEADING_PREFIX.test(prev.text)) {
					break;
				}
				start--;
			}
			while (end < state.doc.lines) {
				const next = state.doc.line(end + 1);
				if (!next.text.trim() || HEADING_PREFIX.test(next.text)) {
					break;
				}
				end++;
			}
		}
	}
	return [start, end];
}

export function buildProseDecorations(state: EditorState, chapter = false): DecorationSet {
	if (!chapter) {
		return plainLines(state);
	}
	const text = state.doc.toString();
	const frontmatter = frontmatterLength(text);
	const spaced = paragraphStyle(text.slice(frontmatter).split('\n')).separator !== '\n\n';
	const [activeStart, activeEnd] = activeLineRange(state, frontmatter, spaced);
	const marks: Range<Decoration>[] = [];
	for (let i = 1; i <= state.doc.lines; i++) {
		const line = state.doc.line(i);
		if (line.from < frontmatter) {
			marks.push(Decoration.line({ class: 'frontmatter' }).range(line.from));
			continue;
		}
		const trimmed = line.text.trim();
		if (!trimmed) {
			marks.push(Decoration.line({ class: 'chapter-blank' }).range(line.from));
			continue;
		}
		const active = i >= activeStart && i <= activeEnd;
		const focusClass = active ? 'active-paragraph' : 'dim-paragraph';
		const nextNonEmpty = i < state.doc.lines && state.doc.line(i + 1).text.trim().length > 0;
		const headingMatch = HEADING_PREFIX.exec(line.text);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const classes = [
				'heading',
				'chapter-heading',
				`chapter-heading-${level}`,
				nextNonEmpty ? 'heading-after-tight' : 'heading-after-blank',
				focusClass,
			].join(' ');
			marks.push(Decoration.line({ class: classes }).range(line.from));
			const cursorOnLine = state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from);
			if (!cursorOnLine) {
				marks.push(Decoration.replace({}).range(line.from, line.from + headingMatch[0].length));
			}
			continue;
		}
		const hasLeadingSpace = /^\s/u.test(line.text);
		const classes = [!hasLeadingSpace ? 'can-indent' : '', nextNonEmpty ? 'chapter-paragraph' : '', focusClass].filter(Boolean).join(' ');
		if (classes) {
			marks.push(Decoration.line({ class: classes }).range(line.from));
		}
	}
	return Decoration.set(marks, true);
}

export function createProse(options: ProseOptions = {}): Extension {
	const chapter = Boolean(options.chapter);
	const pairEnabled = () => (options.autoPair ? options.autoPair() : true);
	return [
		StateField.define<DecorationSet>({
			create: (state) => buildProseDecorations(state, chapter),
			update: (value, tr) => (tr.docChanged || (chapter && tr.selection) ? buildProseDecorations(tr.state, chapter) : value),
			provide: (field) => EditorView.decorations.from(field),
		}),
		EditorView.inputHandler.of((view, from, to, text) => {
			if (view.compositionStarted || text.length !== 1 || !pairEnabled()) {
				return false;
			}
			if (from === to && closers.includes(text) && view.state.sliceDoc(from, from + 1) === text) {
				view.dispatch({ selection: { anchor: from + 1 }, userEvent: 'select' });
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
						if (view.compositionStarted) {
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
						if (view.compositionStarted) {
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
						if (view.compositionStarted || !range.empty || range.head === 0) {
							return false;
						}
						if (pairEnabled()) {
							const before = view.state.sliceDoc(range.head - 1, range.head);
							const after = view.state.sliceDoc(range.head, range.head + 1);
							if (pairs[before] && pairs[before] === after) {
								view.dispatch({
									changes: { from: range.head - 1, to: range.head + 1 },
									selection: { anchor: range.head - 1 },
									userEvent: 'delete.backward',
								});
								return true;
							}
						}
						if (chapter) {
							const line = view.state.doc.lineAt(range.head);
							const indent = /^\s+/u.exec(line.text)?.[0];
							if (indent && range.head === line.from + indent.length) {
								view.dispatch({
									changes: { from: line.from, to: range.head },
									selection: { anchor: line.from },
									userEvent: 'delete.backward',
								});
								return true;
							}
						}
						return false;
					},
				},
			]),
		),
	];
}

export const prose: Extension = createProse();
