import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareNatural, comparePaths, parseChineseNumber } from '../core/naturalSort';

describe('parseChineseNumber', () => {
	const cases: Array<[string, number]> = [
		['一', 1],
		['九', 9],
		['十', 10],
		['十二', 12],
		['二十', 20],
		['二十一', 21],
		['一百', 100],
		['一百零五', 105],
		['一百一十', 110],
		['两百', 200],
		['九百九十九', 999],
		['一千', 1000],
		['两千零二十', 2020],
		['一万二千', 12000],
		['一〇五', 105],
		['二〇二六', 2026],
		['零', 0],
	];
	for (const [text, value] of cases) {
		test(`${text} = ${value}`, () => assert.equal(parseChineseNumber(text), value));
	}
});

describe('compareNatural', () => {
	const sorted = (names: string[]) => [...names].sort(compareNatural);

	test('Arabic numerals by value', () => {
		assert.deepEqual(sorted(['第10章', '第2章', '第1章']), ['第1章', '第2章', '第10章']);
	});

	test('Chinese numerals by value', () => {
		assert.deepEqual(sorted(['第十二章', '第九章', '第一百零五章', '第二十章', '第一章']), [
			'第一章',
			'第九章',
			'第十二章',
			'第二十章',
			'第一百零五章',
		]);
	});

	test('mixed numeral styles compare by value', () => {
		assert.deepEqual(sorted(['第十一章', '第10章', '第九章']), ['第九章', '第10章', '第十一章']);
	});

	test('full-width digits', () => {
		assert.deepEqual(sorted(['第１０章', '第２章']), ['第２章', '第１０章']);
	});

	test('titles after the number do not disturb the order', () => {
		assert.deepEqual(sorted(['第3章 风起', '第12章 灯塔', '第1章 雾里来信']), [
			'第1章 雾里来信',
			'第3章 风起',
			'第12章 灯塔',
		]);
	});

	test('a part after the same chapter number sorts after it', () => {
		assert.deepEqual(sorted(['第1章 下', '第1章', '第1章 上']), ['第1章', '第1章 上', '第1章 下']);
	});
});

describe('comparePaths', () => {
	test('volumes, then chapters, extension ignored', () => {
		const paths = [
			'正文/卷十/第1章.md',
			'正文/卷二/第10章.md',
			'正文/卷二/第2章.txt',
			'正文/卷一/第十二章.md',
			'正文/卷一/第九章.md',
		];
		assert.deepEqual([...paths].sort(comparePaths), [
			'正文/卷一/第九章.md',
			'正文/卷一/第十二章.md',
			'正文/卷二/第2章.txt',
			'正文/卷二/第10章.md',
			'正文/卷十/第1章.md',
		]);
	});

	test('zero-padded numbers', () => {
		assert.deepEqual(['chapters/010.md', 'chapters/002.md', 'chapters/1.md'].sort(comparePaths), [
			'chapters/1.md',
			'chapters/002.md',
			'chapters/010.md',
		]);
	});
});
