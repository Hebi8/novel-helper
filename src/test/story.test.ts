import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	isUsable,
	leadsOut,
	MARKER_FILE,
	MARKER_GLOBS,
	namesLanguageOf,
	normalizeStoryFolder,
	parseMarker,
	relativeInside,
	SCAN_EXCLUDE,
	serializeMarker,
	storiesFromMarkers,
	storyState,
} from '../core/story';

describe('normalizeStoryFolder', () => {
	test('a path below the workspace folder, however it is written', () => {
		assert.equal(normalizeStoryFolder(''), '');
		assert.equal(normalizeStoryFolder('  '), '');
		assert.equal(normalizeStoryFolder('.'), '');
		assert.equal(normalizeStoryFolder('./'), '');
		assert.equal(normalizeStoryFolder('书/雾港'), '书/雾港');
		assert.equal(normalizeStoryFolder(' ./书//雾港/ '), '书/雾港');
		assert.equal(normalizeStoryFolder('books\\fog harbor\\'), 'books/fog harbor');
		assert.equal(normalizeStoryFolder('a/./b'), 'a/b');
		assert.equal(normalizeStoryFolder('..书/第1.5稿'), '..书/第1.5稿', 'dots inside a name are a name');
	});

	test('nothing that could lead out of the workspace folder', () => {
		for (const setting of ['..', '../x', 'a/../../x', 'a/..', '书/../..', '/', '/home/x', '\\\\server\\share', 'C:\\novel', 'c:/novel', '~', '~/novel', 'a\\..\\b']) {
			assert.equal(normalizeStoryFolder(setting), undefined, setting);
		}
	});
});

describe('leadsOut', () => {
	test('a step up anywhere in the path', () => {
		for (const path of ['..', '../x', '大纲/../../escaped-book.md', 'a/b/..', 'a\\..\\b', '正文/../../x/第1章.md']) {
			assert.equal(leadsOut(path), true, path);
		}
		for (const path of ['', '正文/第1章.md', '正文/第1章…….md', '..书/第1.5稿.md', '~草稿/a.md', '.novel-helper/project.json']) {
			assert.equal(leadsOut(path), false, path);
		}
	});
});

describe('relativeInside', () => {
	test('the folder itself, a folder inside it, anything else', () => {
		assert.equal(relativeInside('/home/me/写作', '/home/me/写作'), '');
		assert.equal(relativeInside('/home/me/写作/', '/home/me/写作/书/雾港/'), '书/雾港');
		assert.equal(relativeInside('/home/me/写作', '/home/me/写作2/书'), undefined);
		assert.equal(relativeInside('/home/me/写作', '/home/me'), undefined);
		assert.equal(relativeInside('/home/me/写作', '/tmp/x'), undefined);
	});
});

describe('marker file', () => {
	const marker = {
		version: 1,
		language: 'zh' as const,
		folders: { chapters: '正文', outlines: '大纲', summaries: '摘要', lore: ['设定', '人物', '资料'] },
		book: '全书',
	};

	test('written and read back', () => {
		const text = serializeMarker(marker);
		assert.deepEqual(parseMarker(text), marker);
		assert.ok(text.endsWith('}\n'));
		assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'language', 'folders', 'book'], 'nothing else is stored');
	});

	test('a version number is what makes it a marker', () => {
		assert.deepEqual(parseMarker('{"version": 1}'), { version: 1 });
		assert.deepEqual(parseMarker('{"version": 3, "language": "zh", "layout": {"x": 1}}'), { version: 3, language: 'zh' }, 'a later format still counts');
		for (const text of ['', 'not json', '[]', 'null', '"1"', '{}', '{"version": "1"}', '{"version": 0}', '{"version": 1.5}', '{"language": "zh"}']) {
			assert.equal(parseMarker(text), undefined, text);
		}
	});

	test('fields of the wrong type are dropped', () => {
		assert.deepEqual(parseMarker('{"version": 1, "language": "fr", "folders": {"chapters": 3, "outlines": "大纲", "lore": ["设定", 7]}, "book": []}'), {
			version: 1,
			folders: { chapters: undefined, outlines: '大纲', summaries: undefined, lore: ['设定'] },
		});
		assert.deepEqual(parseMarker('{"version": 1, "folders": ["正文"]}'), { version: 1 });
	});
});

describe('storyState', () => {
	const facts = { valid: true, exists: true, marked: false, hasFiles: false };

	test('from what is known about the folder', () => {
		assert.equal(storyState({ ...facts, valid: false, exists: false }), 'invalid');
		assert.equal(storyState({ ...facts, valid: false, marked: true, hasFiles: true }), 'invalid');
		assert.equal(storyState({ ...facts, exists: false }), 'missing');
		assert.equal(storyState(facts), 'empty');
		assert.equal(storyState({ ...facts, hasFiles: true }), 'unmarked');
		assert.equal(storyState({ ...facts, marked: true }), 'ready', 'initialized, nothing written yet');
		assert.equal(storyState({ ...facts, marked: true, hasFiles: true }), 'ready');
	});

	test('a folder set up by hand or by an earlier version works without a marker', () => {
		assert.deepEqual((['invalid', 'missing', 'empty', 'unmarked', 'ready'] as const).map(isUsable), [false, false, false, true, true]);
	});
});

describe('storiesFromMarkers', () => {
	test('the folders the markers are in, in natural order, without the current one', () => {
		const markers = [`书/第10部/${MARKER_FILE}`, `书/第2部/${MARKER_FILE}`, MARKER_FILE, `草稿/${MARKER_FILE}`];
		assert.deepEqual(storiesFromMarkers(markers), ['', '书/第2部', '书/第10部', '草稿']);
		assert.deepEqual(storiesFromMarkers(markers, '书/第2部'), ['', '书/第10部', '草稿']);
		assert.deepEqual(storiesFromMarkers(markers, ''), ['书/第2部', '书/第10部', '草稿']);
		assert.deepEqual(storiesFromMarkers([]), []);
	});

	test('not too deep, not inside dependencies, build output or hidden folders, and only real marker paths', () => {
		assert.deepEqual(
			storiesFromMarkers([
				`a/b/c/d/${MARKER_FILE}`,
				`a/b/c/d/e/${MARKER_FILE}`,
				`node_modules/pkg/${MARKER_FILE}`,
				`书/node_modules/x/${MARKER_FILE}`,
				`.git/x/${MARKER_FILE}`,
				`.trash/旧稿/${MARKER_FILE}`,
				`dist/书/${MARKER_FILE}`,
				'书/project.json',
				`书/x${MARKER_FILE}`,
				'书/.novel-helper/project.json.bak',
			]),
			['a/b/c/d'],
		);
	});
});

describe('what the search for markers asks for', () => {
	test('one glob per depth down to the limit, and the big folders left out by the search itself', () => {
		assert.deepEqual(MARKER_GLOBS, [MARKER_FILE, `*/${MARKER_FILE}`, `*/*/${MARKER_FILE}`, `*/*/*/${MARKER_FILE}`, `*/*/*/*/${MARKER_FILE}`]);
		assert.ok(MARKER_GLOBS.every((glob) => !glob.includes('**')));
		for (const folder of ['node_modules', '.git', 'build', 'dist', 'out', 'target', 'vendor']) {
			assert.ok(SCAN_EXCLUDE.includes(folder), folder);
		}
	});
});

describe('namesLanguageOf', () => {
	test('by script', () => {
		assert.deepEqual(['正文', 'chapters', 'Volume 1', '第1章', ''].map(namesLanguageOf), ['zh', 'en', 'en', 'zh', 'en']);
	});
});
