import { EditorState, Prec, StateField, type Extension, type Range, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { paragraphStyle } from '../../core/suggestion';
import { countWords } from '../../core/text';

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

export interface EditorWordCounts {
	total: number;
	beforeHead: number;
	selected: number;
}

interface ProseDocStats {
	frontmatter: number;
	spaced: boolean;
	lineWords: number[];
	total: number;
}

function docFrontmatterEnd(doc: Text): number {
	if (doc.lines < 2 || !/^\uFEFF?---[ \t]*\r?$/.test(doc.line(1).text)) {
		return 0;
	}
	for (let i = 2; i <= doc.lines; i++) {
		if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(doc.line(i).text)) {
			return i < doc.lines ? doc.line(i + 1).from : doc.length;
		}
	}
	return 0;
}

function docSpaced(doc: Text, frontmatter: number): boolean {
	if (frontmatter >= doc.length) {
		return false;
	}
	const startLine = frontmatter > 0 ? doc.lineAt(frontmatter).number : 1;
	const sample: string[] = [];
	let proseCount = 0;
	const iter = doc.iterLines(startLine);
	while (!iter.next().done) {
		sample.push(iter.value);
		if (iter.value.trim() && !/^#{1,6}\s/.test(iter.value) && ++proseCount >= 60) {
			break;
		}
	}
	return paragraphStyle(sample).separator !== '\n\n';
}

function createDocStats(doc: Text): ProseDocStats {
	const lineWords: number[] = [];
	let total = 0;
	const iter = doc.iterLines();
	while (!iter.next().done) {
		const words = countWords(iter.value);
		lineWords.push(words);
		total += words;
	}
	const frontmatter = docFrontmatterEnd(doc);
	return { frontmatter, spaced: docSpaced(doc, frontmatter), lineWords, total };
}

function updateDocStats(prev: ProseDocStats, tr: Transaction): ProseDocStats {
	if (!tr.docChanged) {
		return prev;
	}
	const oldDoc = tr.startState.doc;
	const newDoc = tr.state.doc;
	const patches: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] = [];
	tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		const oldStart = oldDoc.lineAt(fromA).number;
		const oldEnd = oldDoc.lineAt(toA).number;
		const newStart = newDoc.lineAt(fromB).number;
		const newEnd = newDoc.lineAt(toB).number;
		const last = patches.at(-1);
		if (last && (oldStart <= last.oldEnd || newStart <= last.newEnd)) {
			last.oldEnd = Math.max(last.oldEnd, oldEnd);
			last.newEnd = Math.max(last.newEnd, newEnd);
		} else {
			patches.push({ oldStart, oldEnd, newStart, newEnd });
		}
	});
	if (!patches.length) {
		return prev;
	}
	const lineWords: number[] = [];
	let total = prev.total;
	let oldLine = 1;
	for (const patch of patches) {
		for (let i = oldLine; i < patch.oldStart; i++) {
			lineWords.push(prev.lineWords[i - 1]);
		}
		for (let i = patch.oldStart; i <= patch.oldEnd; i++) {
			total -= prev.lineWords[i - 1];
		}
		for (let i = patch.newStart; i <= patch.newEnd; i++) {
			const words = countWords(newDoc.line(i).text);
			lineWords.push(words);
			total += words;
		}
		oldLine = patch.oldEnd + 1;
	}
	for (let i = oldLine; i <= oldDoc.lines; i++) {
		lineWords.push(prev.lineWords[i - 1]);
	}
	const frontmatter = prev.frontmatter === 0 && patches[0].newStart > 1 ? 0 : docFrontmatterEnd(newDoc);
	return { frontmatter, spaced: docSpaced(newDoc, frontmatter), lineWords, total };
}

export const proseDocField = StateField.define<ProseDocStats>({
	create: (state) => createDocStats(state.doc),
	update: updateDocStats,
});

function wordsBefore(doc: Text, stats: ProseDocStats, offset: number): number {
	if (offset <= 0) {
		return 0;
	}
	if (offset >= doc.length) {
		return stats.total;
	}
	const line = doc.lineAt(offset);
	let sum = 0;
	for (let i = 0; i < line.number - 1; i++) {
		sum += stats.lineWords[i];
	}
	return sum + countWords(line.text.slice(0, offset - line.from));
}

export function wordCountsAt(state: EditorState): EditorWordCounts {
	const stats = state.field(proseDocField, false) ?? createDocStats(state.doc);
	const main = state.selection.main;
	if (main.empty) {
		return { total: stats.total, beforeHead: wordsBefore(state.doc, stats, main.head), selected: 0 };
	}
	const fromWords = wordsBefore(state.doc, stats, main.from);
	const toWords = wordsBefore(state.doc, stats, main.to);
	return {
		total: stats.total,
		beforeHead: main.head === main.to ? toWords : fromWords,
		selected: toWords - fromWords,
	};
}

const jump = (view: EditorView) => {
	const range = view.state.selection.main;
	if (view.compositionStarted || !range.empty || !closers.includes(view.state.sliceDoc(range.head, range.head + 1))) {
		return false;
	}
	view.dispatch({ selection: { anchor: range.head + 1 }, userEvent: 'select' });
	return true;
};

function visibleLineSpans(doc: Text, ranges?: readonly { from: number; to: number }[]): [number, number][] {
	if (!ranges) {
		return [[1, doc.lines]];
	}
	const spans: [number, number][] = [];
	for (const { from, to } of ranges) {
		const start = doc.lineAt(from).number;
		const end = doc.lineAt(to).number;
		const prev = spans.at(-1);
		if (prev && start <= prev[1] + 1) {
			prev[1] = Math.max(prev[1], end);
		} else {
			spans.push([start, end]);
		}
	}
	return spans;
}

function plainLines(state: EditorState, frontmatter: number, spaced: boolean, spans: [number, number][]): DecorationSet {
	const marks: Range<Decoration>[] = [];
	for (const [start, end] of spans) {
		for (let i = start; i <= end; i++) {
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
	}
	return Decoration.set(marks);
}

function activeLineRange(state: EditorState, frontmatter: number, spaced: boolean, minLine: number, maxLine: number): [number, number] {
	const main = state.selection.main;
	let start = state.doc.lineAt(main.from).number;
	let end = state.doc.lineAt(main.to).number;
	if (!spaced && start === end) {
		const current = state.doc.line(start);
		const isProse = current.from >= frontmatter && current.text.trim().length > 0 && !HEADING_PREFIX.test(current.text);
		if (isProse) {
			const floor = start <= maxLine ? Math.max(1, minLine) : 1;
			const ceiling = end >= minLine ? Math.min(state.doc.lines, maxLine) : state.doc.lines;
			while (start > floor) {
				const prev = state.doc.line(start - 1);
				if (prev.from < frontmatter || !prev.text.trim() || HEADING_PREFIX.test(prev.text)) {
					break;
				}
				start--;
			}
			while (end < ceiling) {
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

export function buildProseDecorations(
	state: EditorState,
	chapter = false,
	visibleRanges?: readonly { from: number; to: number }[],
): DecorationSet {
	const spans = visibleLineSpans(state.doc, visibleRanges);
	if (!spans.length) {
		return Decoration.none;
	}
	const stats = state.field(proseDocField, false);
	const frontmatter = stats ? stats.frontmatter : docFrontmatterEnd(state.doc);
	const spaced = stats ? stats.spaced : docSpaced(state.doc, frontmatter);
	if (!chapter) {
		return plainLines(state, frontmatter, spaced, spans);
	}
	const [activeStart, activeEnd] = activeLineRange(state, frontmatter, spaced, spans[0][0], spans.at(-1)![1]);
	const marks: Range<Decoration>[] = [];
	for (const [start, end] of spans) {
		let line = state.doc.line(start);
		for (let i = start; i <= end; i++) {
			const nextLine = i < state.doc.lines ? state.doc.line(i + 1) : undefined;
			if (line.from < frontmatter) {
				marks.push(Decoration.line({ class: 'frontmatter' }).range(line.from));
			} else if (!line.text.trim()) {
				marks.push(Decoration.line({ class: 'chapter-blank' }).range(line.from));
			} else {
				const active = i >= activeStart && i <= activeEnd;
				const focusClass = active ? 'active-paragraph' : 'dim-paragraph';
				const nextNonEmpty = Boolean(nextLine && nextLine.text.trim().length > 0);
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
				} else {
					const hasLeadingSpace = /^\s/u.test(line.text);
					const classes = [!hasLeadingSpace ? 'can-indent' : '', nextNonEmpty ? 'chapter-paragraph' : '', focusClass]
						.filter(Boolean)
						.join(' ');
					if (classes) {
						marks.push(Decoration.line({ class: classes }).range(line.from));
					}
				}
			}
			if (nextLine) {
				line = nextLine;
			}
		}
	}
	return Decoration.set(marks, true);
}

export function createProse(options: ProseOptions = {}): Extension {
	const chapter = Boolean(options.chapter);
	const pairEnabled = () => (options.autoPair ? options.autoPair() : true);
	return [
		proseDocField,
		ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = buildProseDecorations(view.state, chapter, view.visibleRanges);
				}
				update(update: ViewUpdate) {
					if (update.docChanged || update.viewportChanged || (chapter && update.selectionSet)) {
						this.decorations = buildProseDecorations(update.state, chapter, update.view.visibleRanges);
					}
				}
			},
			{ decorations: (plugin) => plugin.decorations },
		),
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
