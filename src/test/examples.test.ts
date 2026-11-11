// The example workspace, indexed the way the extension indexes a folder with
// the default settings, gives the context the README says it gives.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildContext, type ContextLimits, userText } from '../core/context';
import { type FileKind, globRootDepth, Library } from '../core/library';

const root = path.resolve(__dirname, '../..');
const examples = path.join(root, 'examples');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const defaults = manifest.contributes.configuration.properties as Record<string, { default: unknown }>;

function files(dir: string): string[] {
	return fs.readdirSync(path.join(examples, dir), { withFileTypes: true }).flatMap((d) => {
		const relative = dir ? `${dir}/${d.name}` : d.name;
		return d.isDirectory() ? files(relative) : [relative];
	});
}

const read = (relative: string) => fs.readFileSync(path.join(examples, relative), 'utf8');

/** The first folder of a default glob (`{正文,章节,…}/**`) as the folder names it accepts. */
function folders(setting: string): { names: string[]; rootDepth: number } {
	const [glob] = defaults[`novelHelper.files.${setting}`].default as string[];
	return { names: glob.split('/')[0].replace(/[{}]/g, '').split(','), rootDepth: globRootDepth(glob) };
}

function index(): Library {
	const library = new Library(defaults['novelHelper.files.bookNames'].default as string[]);
	const kinds: Array<[string, 'lore' | FileKind]> = [['lore', 'lore'], ['chapters', 'chapter'], ['outlines', 'outline'], ['summaries', 'summary']];
	for (const [setting, kind] of kinds) {
		const { names, rootDepth } = folders(setting);
		for (const file of files('').filter((f) => names.includes(f.split('/')[0]))) {
			if (kind === 'lore') {
				library.setLore(file, read(file));
			} else {
				library.addFile(kind, file, rootDepth);
			}
		}
	}
	return library;
}

const limits = Object.fromEntries(
	Object.entries(defaults)
		.filter(([key]) => key.startsWith('novelHelper.context.') && key.endsWith('Chars'))
		.map(([key, value]) => [key.slice('novelHelper.context.'.length), value.default]),
) as unknown as ContextLimits;

test('examples: the second chapter gets the outlines of the book, its volume and its arc, and the lore it names', () => {
	const library = index();
	const chapter = '正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md';
	assert.deepEqual(library.chapterList(), ['正文/第一卷 雾港/第一幕 来信/第1章 雾里来信.md', chapter]);
	assert.deepEqual(library.levelsOf(chapter).map((level) => [level.name, level.outline]), [
		['全书', '大纲/全书.md'],
		['第一卷 雾港', '大纲/第一卷 雾港.md'],
		['第一幕 来信', '大纲/第一卷 雾港/第一幕 来信.md'],
	]);
	const outline = library.companionOf('outline', chapter)!;
	assert.equal(outline, '大纲/第一卷 雾港/第一幕 来信/第2章 灯塔.md');

	const { prompt, trace } = buildContext({
		documentPath: chapter,
		before: read(chapter),
		after: '',
		entries: library.entries(),
		matcher: library.matcher(),
		levels: library.levelsOf(chapter).map((level) => ({
			name: level.name,
			book: level.path === '',
			outline: level.outline ? { path: level.outline, content: read(level.outline) } : undefined,
		})),
		outline: { path: outline, content: read(outline) },
		previous: library.previousChapters(chapter, 3).map((p) => {
			const summary = library.companionOf('summary', p);
			return summary ? { path: p, summary: read(summary) } : { path: p, text: read(p) };
		}),
		limits,
	});
	assert.deepEqual(trace.levels.map((level) => [level.path !== undefined, level.truncated]), [[true, false], [true, false], [true, false]]);
	assert.deepEqual(trace.previous.map((p) => p.source), ['summary']);
	assert.deepEqual(trace.always.map((e) => e.name), ['文风']);
	const matched = new Map(trace.matched.map((e) => [e.name, e.hit!]));
	assert.deepEqual([...matched.keys()].sort(), ['北角灯塔', '周伯', '林小满', '潮汐钟', '陆青', '陆青山']);
	assert.deepEqual([...matched.get('陆青山')!.keys.keys()], ['陆青山'], '陆青山 is its own entry, not a mention of 陆青');
	assert.equal(matched.get('潮汐钟')!.count, 0, '潮汐钟 comes in through the outline alone');
	assert.deepEqual(trace.skipped, []);

	const user = userText(prompt);
	const order = ['<上层大纲>', '【全书】', '【第一卷 雾港】', '【第一幕 来信】', '<前文>', '<本章大纲>', '<本章涉及的资料>', '<当前章节'];
	assert.deepEqual([...order].sort((a, b) => user.indexOf(a) - user.indexOf(b)), order);
	assert.ok(order.every((mark) => user.includes(mark)));
	// What the README's cost section quotes; printed with `node --test` output for whoever updates it.
	const cached = prompt.system.length + prompt.user.slice(0, prompt.user.map((b) => b.cache).lastIndexOf(true) + 1).reduce((n, b) => n + b.text.length, 0);
	assert.ok(cached / (prompt.system.length + user.length) > 0.8, 'most of the prompt is before the last cache breakpoint');
});
