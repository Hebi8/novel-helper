import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { EditorState, Text } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { countWords } from '../core/text';
import { writingDayKey } from '../core/words';
import { SettingsStore } from '../main/settings/store';
import { buildProseDecorations, createProse, wordCountsAt } from '../renderer/editor/prose';
import { defaults } from '../shared/defaults';
import { WordCountStore } from '../storage/wordCountStore';

describe('WordCountStore and writingDayKey', () => {
	test('tracks net chapter word additions and deletions per book and persists across reloads', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-words-'));
		t.after(() => rm(root, { recursive: true, force: true }));
		const storeDir = join(root, 'word-counts');
		const bookA = join(root, 'book-a');
		const bookB = join(root, 'book-b');
		let currentNow = new Date(2026, 10, 17, 14, 30, 0);

		const store = new WordCountStore(storeDir, () => currentNow);
		store.openBook(bookA, countWords('初始章节内容'));
		store.openBook(bookB, 100);
		assert.equal(store.today(bookA, 0), 0);
		assert.equal(store.today(bookB, 0), 0);

		// Typing adds words; deleting subtracts words.
		store.recordTotal(bookA, countWords('初始章节内容，今天新写了十字。'));
		assert.equal(store.today(bookA, 0), 9);
		store.recordTotal(bookA, countWords('初始章节内容，今天新写了'));
		assert.equal(store.today(bookA, 0), 6);
		assert.equal(store.today(bookB, 0), 0);

		// Deleting below initial baseline produces negative net count cleanly.
		store.recordTotal(bookA, countWords('初始'));
		assert.equal(store.today(bookA, 0), -4);

		// Reloading store from disk preserves per-book counts.
		currentNow = new Date(2026, 10, 17, 16, 0, 0);
		const reloaded = new WordCountStore(storeDir, () => currentNow);
		reloaded.openBook(bookA, countWords('初始'));
		reloaded.recordTotal(bookA, countWords('初始章节内容，补回来了'));
		assert.equal(reloaded.today(bookA, 0), 5);
		assert.equal(reloaded.today(bookB, 0), 0);
	});

	test('attributes early-morning writing before dayStartHour to the previous writing day', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-words-hour-'));
		t.after(() => rm(root, { recursive: true, force: true }));
		const book = join(root, 'book');
		let currentNow = new Date(2026, 10, 17, 23, 30, 0);
		const store = new WordCountStore(join(root, 'word-counts'), () => currentNow);

		assert.equal(writingDayKey(new Date(2026, 10, 18, 3, 15, 0), 4), '2026-11-17');
		assert.equal(writingDayKey(new Date(2026, 10, 18, 4, 0, 0), 4), '2026-11-18');
		assert.equal(writingDayKey(new Date(2026, 10, 18, 3, 15, 0), 0), '2026-11-18');

		store.openBook(book, 100);
		// 23:30 on Nov 17: +200 words
		store.recordTotal(book, 300);
		// 03:00 on Nov 18: +150 words
		currentNow = new Date(2026, 10, 18, 3, 0, 0);
		store.recordTotal(book, 450);

		// At 03:30 on Nov 18:
		currentNow = new Date(2026, 10, 18, 3, 30, 0);
		// With default startHour = 0, only the 03:00 words belong to Nov 18.
		assert.equal(store.today(book, 0), 150);
		// With startHour = 4, 03:30 is still part of Nov 17's writing day (200 + 150 = 350).
		assert.equal(store.today(book, 4), 350);

		// At 04:05 on Nov 18, with startHour = 4, the new writing day has started (0 words so far).
		currentNow = new Date(2026, 10, 18, 4, 5, 0);
		assert.equal(store.today(book, 4), 0);
	});
});

describe('chapter prose decorations and indent backspace', () => {
	function collectSpecs(state: EditorState, chapter: boolean) {
		const decos = buildProseDecorations(state, chapter);
		const lines: { pos: number; cls: string }[] = [];
		const replaces: { from: number; to: number }[] = [];
		const iter = decos.iter();
		while (iter.value) {
			const spec = iter.value.spec as { class?: string };
			if (iter.from === iter.to && spec.class) {
				lines.push({ pos: iter.from, cls: spec.class });
			} else if (iter.from < iter.to) {
				replaces.push({ from: iter.from, to: iter.to });
			}
			iter.next();
		}
		return { lines, replaces };
	}

	test('chapter mode hides heading # prefix when cursor is outside the line and reveals it when cursor enters', () => {
		const doc = '# 第2章 灯塔\n\n周伯的旧屋。\n\n　　已有全角缩进。\n\t已有制表缩进。';
		const outside = EditorState.create({ doc, selection: { anchor: doc.indexOf('周伯') } });
		const { lines, replaces } = collectSpecs(outside, true);

		// Heading prefix "# " ([0, 2]) is replaced visually while document text stays untouched.
		assert.deepEqual(replaces, [{ from: 0, to: 2 }]);
		assert.equal(outside.doc.toString(), doc);

		// Unindented prose gets can-indent; lines starting with full-width space or Tab do not.
		const unindented = lines.find((l) => l.pos === doc.indexOf('周伯'))!;
		const fullWidth = lines.find((l) => l.pos === doc.indexOf('　　已有'))!;
		const tabbed = lines.find((l) => l.pos === doc.indexOf('\t已有'))!;
		assert.match(unindented.cls, /\bcan-indent\b/);
		assert.match(unindented.cls, /\bactive-paragraph\b/);
		assert.doesNotMatch(fullWidth.cls, /\bcan-indent\b/);
		assert.match(fullWidth.cls, /\bdim-paragraph\b/);
		assert.doesNotMatch(tabbed.cls, /\bcan-indent\b/);

		// Moving cursor onto heading line reveals "# ".
		const inside = EditorState.create({ doc, selection: { anchor: 3 } });
		assert.deepEqual(collectSpecs(inside, true).replaces, []);

		// Non-chapter mode (outline/lore) never hides "# " or adds can-indent.
		const outlineSpecs = collectSpecs(outside, false);
		assert.deepEqual(outlineSpecs.replaces, []);
		assert.ok(outlineSpecs.lines.every((l) => !l.cls.includes('can-indent')));
	});

	test('Backspace right after leading indent deletes the whole indent in chapter mode only', () => {
		const pressBackspace = (doc: string, head: number, chapter: boolean) => {
			let current = EditorState.create({
				doc,
				selection: { anchor: head },
				extensions: [createProse({ chapter })],
			});
			const fakeView = {
				get state() {
					return current;
				},
				compositionStarted: false,
				dispatch(spec: Parameters<EditorState['update']>[0]) {
					current = current.update(spec).state;
				},
			} as unknown as EditorView;
			const binding = current
				.facet(keymap)
				.flat()
				.find((item) => item.key === 'Backspace')!;
			const handled = binding.run!(fakeView);
			return { handled, text: current.doc.toString(), head: current.selection.main.head };
		};

		// Full-width two-char indent before text -> deleted in one Backspace.
		const fullWidth = pressBackspace('第一段\n　　林小满回头。', '第一段\n　　'.length, true);
		assert.equal(fullWidth.handled, true);
		assert.equal(fullWidth.text, '第一段\n林小满回头。');
		assert.equal(fullWidth.head, '第一段\n'.length);

		// Indented blank line (e.g. right after pressing Enter) -> deleted in one Backspace.
		const blankIndent = pressBackspace('　　第一段\n　　', '　　第一段\n　　'.length, true);
		assert.equal(blankIndent.handled, true);
		assert.equal(blankIndent.text, '　　第一段\n');

		// Cursor after prose character -> not intercepted by whole-indent Backspace.
		const midLine = pressBackspace('　　林小满', '　　林'.length, true);
		assert.equal(midLine.handled, false);

		// Non-chapter file -> whole-indent Backspace does not intercept.
		const nonChapter = pressBackspace('　　大纲项', 2, false);
		assert.equal(nonChapter.handled, false);
	});

	test('100,000-character chapter performs 0 full-document reads across 30 cursor moves and updates word counts incrementally', (t) => {
		const paragraphs: string[] = ['# 第1章 十万字长章'];
		for (let i = 1; i <= 2800; i++) {
			paragraphs.push(`　　第${String(i).padStart(4, '0')}段，海雾顺着旧石阶漫上来，灯塔顶上的黄铜透镜在夜风里轻轻作响。`);
		}
		const doc = paragraphs.join('\n\n');
		const expectedTotal = countWords(doc);
		assert.ok(expectedTotal > 100_000);

		let state = EditorState.create({
			doc,
			selection: { anchor: 0 },
			extensions: [createProse({ chapter: true })],
		});
		assert.equal(wordCountsAt(state).total, expectedTotal);

		let fullToStringCalls = 0;
		let fullIterLinesCalls = 0;
		let largeSliceCalls = 0;
		let lineReads = 0;

		const origToString = Text.prototype.toString;
		const origIterLines = Text.prototype.iterLines;
		const origLine = Text.prototype.line;
		const docProto = Object.getPrototypeOf(state.doc) as Text;
		const origSlice = docProto.sliceString;

		t.mock.method(Text.prototype, 'toString', function (this: Text) {
			if (this.length > 1000) {
				fullToStringCalls++;
			}
			return origToString.call(this);
		});
		t.mock.method(Text.prototype, 'iterLines', function (this: Text, from?: number, to?: number) {
			if (from === undefined && to === undefined) {
				fullIterLinesCalls++;
			}
			return origIterLines.call(this, from, to);
		});
		t.mock.method(docProto, 'sliceString', function (this: Text, from: number, to?: number, lineSep?: string) {
			const end = to ?? this.length;
			if (end - from > 1000) {
				largeSliceCalls++;
			}
			return origSlice.call(this, from, to, lineSep);
		});
		t.mock.method(Text.prototype, 'line', function (this: Text, n: number) {
			lineReads++;
			return origLine.call(this, n);
		});

		const length = state.doc.length;
		for (let step = 0; step < 30; step++) {
			const head = Math.floor(((step + 1) * (length - 1)) / 30);
			const anchor = step % 5 === 0 ? Math.max(0, head - 120) : head;
			state = state.update({ selection: { anchor, head } }).state;
			const vpFrom = Math.max(0, head - 600);
			const vpTo = Math.min(length, head + 600);
			buildProseDecorations(state, true, [{ from: vpFrom, to: vpTo }]);
			const counts = wordCountsAt(state);
			assert.equal(counts.total, expectedTotal);
			if (anchor !== head) {
				assert.equal(counts.selected, countWords(doc.slice(anchor, head)));
			}
		}

		assert.equal(fullToStringCalls, 0);
		assert.equal(fullIterLinesCalls, 0);
		assert.equal(largeSliceCalls, 0);
		// Across all 30 cursor moves combined, total line reads stay smaller than even a single 5,600-line full scan.
		assert.ok(lineReads < state.doc.lines, `expected O(viewport) line reads, got ${lineReads} for ${state.doc.lines} lines`);

		// Check exact cursor-before word count near the end of the 100k document without full-doc reads.
		const tailPos = length - 25;
		state = state.update({ selection: { anchor: tailPos } }).state;
		const tailCounts = wordCountsAt(state);
		assert.equal(tailCounts.beforeHead, countWords(doc.slice(0, tailPos)));
		assert.equal(fullToStringCalls, 0);
		assert.equal(fullIterLinesCalls, 0);
		assert.equal(largeSliceCalls, 0);

		// Incremental edit (insert + line split + delete) updates total and beforeHead accurately without full-doc reads.
		state = state.update({
			changes: { from: tailPos, to: tailPos + 4, insert: '新加的一句\n　　换了一行' },
			selection: { anchor: tailPos + 12 },
		}).state;
		const updatedDoc = doc.slice(0, tailPos) + '新加的一句\n　　换了一行' + doc.slice(tailPos + 4);
		const afterEdit = wordCountsAt(state);
		assert.equal(afterEdit.total, countWords(updatedDoc));
		assert.equal(afterEdit.beforeHead, countWords(updatedDoc.slice(0, tailPos + 12)));
		assert.equal(fullToStringCalls, 0);
		assert.equal(fullIterLinesCalls, 0);
		assert.equal(largeSliceCalls, 0);
	});
});

describe('SettingsStore backward compatibility', () => {
	test('loads an existing pre-redesign settings.json and fills in new defaults', async (t) => {
		const dir = await mkdtemp(join(tmpdir(), 'novel-old-settings-'));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const legacy = {
			'editor.fontFamily': 'Songti SC',
			'editor.fontSize': 19,
			'editor.centerLine': true,
			enabled: false,
			trigger: 'manual',
			debounceMs: 900,
			provider: 'deepseek',
			'deepseek.model': 'deepseek-chat',
			'usage.dailyLimitUsd': 2.5,
			'assistant.agent': 'custom',
			'assistant.command': '/usr/local/bin/my-agent',
			'assistant.args': ['--acp'],
			'snapshots.intervalMinutes': 15,
		};
		await writeFile(join(dir, 'settings.json'), JSON.stringify(legacy, null, 2));

		const store = new SettingsStore(dir);
		const loaded = store.get();
		assert.equal(loaded['editor.fontFamily'], 'Songti SC');
		assert.equal(loaded['editor.fontSize'], 19);
		assert.equal(loaded['editor.centerLine'], true);
		assert.equal(loaded.enabled, false);
		assert.equal(loaded.trigger, 'manual');
		assert.equal(loaded.debounceMs, 900);
		assert.equal(loaded.provider, 'deepseek');
		assert.equal(loaded['deepseek.model'], 'deepseek-chat');
		assert.equal(loaded['usage.dailyLimitUsd'], 2.5);
		assert.equal(loaded['assistant.command'], '/usr/local/bin/my-agent');
		assert.deepEqual(loaded['assistant.args'], ['--acp']);
		assert.equal(loaded['snapshots.intervalMinutes'], 15);
		// Newly added settings fall back cleanly to defaults.
		assert.equal(loaded['editor.lineHeight'], defaults['editor.lineHeight']);
		assert.equal(loaded['editor.paragraphSpacing'], defaults['editor.paragraphSpacing']);
		assert.equal(loaded['editor.firstLineIndent'], defaults['editor.firstLineIndent']);
		assert.equal(loaded['editor.dayStartHour'], 0);
		assert.equal(loaded['appearance.theme'], 'system');
	});
});
