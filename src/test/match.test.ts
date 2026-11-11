import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Matcher, rankHits } from '../core/match';

function keys(m: Matcher, text: string): string[] {
	return m.find(text).map((x) => x.key);
}

describe('Matcher: longest match', () => {
	const m = new Matcher([
		['张三', 'zs'],
		['张三丰', 'zsf'],
		['三哥', 'zs'],
	]);

	test('「张三丰」 is not read as 「张三」', () => {
		assert.deepEqual(keys(m, '张三丰来了'), ['张三丰']);
		assert.deepEqual(m.find('张三丰来了')[0].ids, ['zsf']);
	});

	test('both names in one sentence', () => {
		const found = m.find('张三丰看了张三一眼');
		assert.deepEqual(found.map((x) => [x.key, x.start, x.end]), [
			['张三丰', 0, 3],
			['张三', 5, 7],
		]);
	});

	test('aliases map to the same entry', () => {
		assert.deepEqual(m.find('三哥说').map((x) => x.ids), [['zs']]);
	});

	test('every occurrence is reported', () => {
		assert.deepEqual(keys(m, '张三，张三，还是张三'), ['张三', '张三', '张三']);
	});

	test('no match', () => {
		assert.deepEqual(m.find('李四走了'), []);
		assert.deepEqual(new Matcher([]).find('张三'), []);
	});
});

describe('Matcher: details', () => {
	test('a key shared by two entries reports both', () => {
		const m = new Matcher([
			['师父', 'a'],
			['师父', 'b'],
		]);
		assert.deepEqual(m.find('师父来了')[0].ids, ['a', 'b']);
	});

	test('Latin keys need word boundaries and ignore case', () => {
		const m = new Matcher([
			['Al', 'al'],
			['NOVA', 'nova'],
		]);
		assert.deepEqual(keys(m, 'Also, al said'), ['Al']);
		assert.deepEqual(keys(m, '他看着Al笑'), ['Al']);
		assert.deepEqual(keys(m, 'supernova, nova!'), ['NOVA']);
	});

	test('a longer key that fails its boundary falls back to a shorter one', () => {
		const m = new Matcher([
			['李', 'li'],
			['李A', 'lia'],
		]);
		assert.deepEqual(keys(m, '李AB'), ['李']);
		assert.deepEqual(keys(m, '李A走了'), ['李A']);
	});

	test('keys are trimmed; empty keys are ignored', () => {
		const m = new Matcher([
			[' 张三 ', 'zs'],
			['', 'x'],
			['  ', 'y'],
		]);
		assert.equal(m.size, 1);
		assert.deepEqual(keys(m, '张三'), ['张三']);
	});

	test('at() finds the match under an offset, preferring the longest segmentation', () => {
		const m = new Matcher([
			['张三', 'zs'],
			['张三丰', 'zsf'],
		]);
		const line = '他说张三丰来了';
		assert.equal(m.at(line, 3)?.key, '张三丰');
		assert.equal(m.at(line, 5)?.key, '张三丰', 'cursor right after the name');
		assert.equal(m.at(line, 0), undefined);
	});

	test('surrogate pairs are matched whole', () => {
		const m = new Matcher([['𠮷野', 'y']]);
		assert.deepEqual(keys(m, '我是𠮷野家'), ['𠮷野']);
	});
});

describe('rankHits', () => {
	const m = new Matcher([
		['甲', 'a'],
		['乙', 'b'],
		['丙', 'c'],
		['丁', 'd'],
	]);

	test('closer and more frequent mentions rank higher', () => {
		const text = `甲甲甲${'。'.repeat(2000)}乙。丙`;
		const hits = rankHits(m.find(text), text.length);
		assert.deepEqual(hits.map((h) => h.id), ['c', 'b', 'a']);
		const a = hits.find((h) => h.id === 'a')!;
		assert.equal(a.count, 3);
		assert.equal(a.keys.get('甲'), 3);
		assert.equal(hits.find((h) => h.id === 'c')!.nearest, 0);
	});

	test('many mentions a little further back beat one mention at the cursor', () => {
		const text = `甲${'。'.repeat(10)}甲${'。'.repeat(10)}甲${'。'.repeat(10)}乙`;
		assert.deepEqual(rankHits(m.find(text), text.length).map((h) => h.id), ['a', 'b']);
	});

	test('names in the outline count even if not yet in the text', () => {
		const text = '甲';
		const hits = rankHits(m.find(text), text.length, m.find('丁出场，甲'));
		const d = hits.find((h) => h.id === 'd')!;
		assert.equal(d.inOutline, true);
		assert.equal(d.count, 0);
		assert.equal(d.nearest, undefined);
		assert.equal(hits[0].id, 'a', 'text mention plus outline beats outline alone');
		assert.equal(hits.find((h) => h.id === 'a')!.inOutline, true);
	});
});
