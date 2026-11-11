import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chunkEnds, steppedStart } from '../core/text';

describe('steppedStart', () => {
	test('nothing to cut while the text fits', () => {
		assert.equal(steppedStart('字'.repeat(100), 100, 30), 0);
		assert.equal(steppedStart('', 0, 1), 0);
	});

	test('moves a whole step at a time, so the start holds while the text grows', () => {
		const starts = [101, 110, 130, 131, 160, 161].map((length) => steppedStart('字'.repeat(length), 100, 30));
		assert.deepEqual(starts, [30, 30, 30, 60, 60, 90]);
	});

	test('a start that lands mid-line moves to the next line when that is close', () => {
		const line = `${'字'.repeat(9)}\n`;
		assert.equal(steppedStart(line.repeat(13), 100, 35), 40, '35 is mid-line; the next line starts at 40');
		assert.equal(steppedStart(`${'字'.repeat(60)}\n${'字'.repeat(60)}`, 100, 30), 30, 'the next line is too far: cut mid-line');
		assert.equal(steppedStart(line.repeat(13), 100, 30), 30, 'already at a line start');
	});

	test('does not split a surrogate pair; a zero limit leaves nothing', () => {
		const text = `${'字'.repeat(29)}😀${'字'.repeat(100)}`;
		assert.equal(steppedStart(text, 101, 30), 31);
		assert.equal(steppedStart('一二三', 0, 1), 3);
	});
});

describe('chunkEnds', () => {
	const line = `${'字'.repeat(9)}\n`;

	test('each piece is at least the size and ends with a line break; the unfinished rest is left out', () => {
		assert.deepEqual(chunkEnds(line.repeat(7) + '半行', 25), [30, 60]);
		assert.deepEqual(chunkEnds(line.repeat(6), 30), [30, 60]);
		assert.deepEqual(chunkEnds('没有换行的一长段'.repeat(20), 25), []);
		assert.deepEqual(chunkEnds('', 25), []);
	});

	test('appending never moves an offset', () => {
		let text = '';
		let previous: number[] = [];
		for (let i = 0; i < 40; i++) {
			text += i % 3 ? '又写了几个字，' : '一行写完了。\n';
			const ends = chunkEnds(text, 20);
			assert.deepEqual(ends.slice(0, previous.length), previous);
			previous = ends;
		}
		assert.ok(previous.length > 5);
	});
});
