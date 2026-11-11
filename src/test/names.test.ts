import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { firstName, formatChineseNumber, nextName } from '../core/names';
import { parseChineseNumber } from '../core/naturalSort';

describe('formatChineseNumber', () => {
	test('reads the way chapter numbers are written', () => {
		const cases: Array<[number, string]> = [
			[1, '一'], [9, '九'], [10, '十'], [11, '十一'], [19, '十九'], [20, '二十'], [21, '二十一'], [99, '九十九'],
			[100, '一百'], [101, '一百零一'], [110, '一百一十'], [111, '一百一十一'], [120, '一百二十'], [999, '九百九十九'],
			[1000, '一千'], [1001, '一千零一'], [1010, '一千零一十'], [1100, '一千一百'], [2020, '二千零二十'],
			[10000, '一万'], [10001, '一万零一'], [12000, '一万二千'], [100000, '十万'],
		];
		for (const [n, text] of cases) {
			assert.equal(formatChineseNumber(n), text);
			assert.equal(parseChineseNumber(text), n, `${text} reads back`);
		}
	});

	test('every number up to 3000 reads back as itself', () => {
		for (let n = 1; n <= 3000; n++) {
			assert.equal(parseChineseNumber(formatChineseNumber(n)), n);
		}
	});
});

describe('nextName', () => {
	test('the next number in the same pattern, without the title', () => {
		const cases: Array<[string, string]> = [
			['第11章 雾里来信', '第12章 '],
			['第9章 灯塔', '第10章 '],
			['第十一章 雾里来信', '第十二章 '],
			['第九章 灯塔', '第十章 '],
			['第十九章', '第二十章'],
			['第九十九章 x', '第一百章 '],
			['第一百零九章 x', '第一百一十章 '],
			['第十一章：雾', '第十二章：'],
			['第一卷 雾港', '第二卷 '],
			['第一幕 来信', '第二幕 '],
			['卷二', '卷三'],
			['第3章雾里来信', '第4章'],
			['第三回', '第四回'],
			['Chapter 9 - Fog', 'Chapter 10 - '],
			['Chapter 9', 'Chapter 10'],
			['ch09_fog', 'ch10_'],
			['011 雾', '012 '],
			['099', '100'],
			['12. 雾', '13. '],
			['第一〇九章 雾', '第一一〇章 '],
			['第11章 2026年的雾', '第12章 '],
		];
		for (const [previous, next] of cases) {
			assert.equal(nextName(previous), next, previous);
		}
	});

	test('no number, no suggestion', () => {
		assert.equal(nextName('序章'), undefined);
		assert.equal(nextName('楔子 雾'), undefined);
		assert.equal(nextName('序章 一个人'), undefined, 'a numeral that numbers nothing');
		assert.equal(nextName('番外 三哥'), undefined);
	});
});

describe('firstName', () => {
	test('the pattern of another one, numbered one', () => {
		assert.equal(firstName('第三幕 回潮'), '第一幕 ');
		assert.equal(firstName('第12章 雾'), '第1章 ');
		assert.equal(firstName('Vol.2 Tide'), 'Vol.1 ');
		assert.equal(firstName('尾声'), undefined);
	});
});
