import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	costOf,
	dayKey,
	dollars,
	emptyTotals,
	estimateTokens,
	type Ledger,
	overDailyLimit,
	prune,
	ratesFor,
	record,
	sum,
	totalsFor,
} from '../core/usage';
import { PROVIDERS } from '../llm/providers';

const near = (actual: number | undefined, expected: number) =>
	assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);

describe('costOf', () => {
	test('each kind of token at its own price', () => {
		const rates = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
		near(costOf({ input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 400_000, output: 100_000 }, rates), 0.1 + 0.02 + 0.05 + 0.05);
		near(costOf({ input: 400, cacheRead: 6000, cacheWrite: 300, output: 20 }, rates), 0.0001475);
	});

	test('cache prices default to the input price; missing cache counts are zero', () => {
		near(costOf({ input: 1000, cacheRead: 1000, cacheWrite: 1000, output: 0 }, { input: 2, output: 8 }), 0.006);
		near(costOf({ input: 1000, output: 100 }, { input: 2, output: 8, cacheRead: 0.2 }), 0.0028);
	});

	test('unknown without an input or an output count', () => {
		const rates = { input: 1, output: 1 };
		assert.equal(costOf({}, rates), undefined);
		assert.equal(costOf({ input: 10 }, rates), undefined);
		near(costOf({ input: 10, output: 3, outputEstimated: true }, rates), 0.000013);
	});
});

describe('ratesFor', () => {
	const noon = new Date('2026-11-12T12:00:00Z');

	test('published prices only for the model they were published for', () => {
		const { pricing } = PROVIDERS.anthropic;
		assert.deepEqual(ratesFor('claude-haiku-5-5', noon, pricing), { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
		assert.equal(ratesFor('claude-sonnet-5-5', noon, pricing), undefined);
		assert.equal(ratesFor('qwen3', noon, PROVIDERS.openaiCompatible.pricing), undefined);
		assert.deepEqual(ratesFor('gpt-6-luna', noon, PROVIDERS.openai.pricing), { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
		assert.deepEqual(ratesFor('gemini-3.5-flash-lite', noon, PROVIDERS.gemini.pricing), { input: 0.3, output: 2.5, cacheRead: 0.03 });
	});

	test('the user\'s own prices win, and cover models without a published price', () => {
		const own = { 'claude-haiku-5-5': { input: 0.2, output: 1 }, qwen3: { input: 0, output: 0 } };
		assert.deepEqual(ratesFor('claude-haiku-5-5', noon, PROVIDERS.anthropic.pricing, own), { input: 0.2, output: 1 });
		assert.deepEqual(ratesFor('qwen3', noon, undefined, own), { input: 0, output: 0 });
		const broken = { 'claude-haiku-5-5': { input: '0.2' } } as never;
		assert.equal(ratesFor('claude-haiku-5-5', noon, PROVIDERS.anthropic.pricing, broken)?.input, 0.1, 'an entry without numbers is ignored');
	});

	test('DeepSeek: double on weekdays 01:00-04:00 and 06:00-10:00 UTC', () => {
		const { pricing } = PROVIDERS.deepseek;
		const at = (iso: string) => ratesFor('deepseek-flash', new Date(iso), pricing);
		const offPeak = { input: 0.15, output: 0.6, cacheRead: 0.003 };
		const peak = { input: 0.3, output: 1.2, cacheRead: 0.006 };
		// 2026-11-12 is a Thursday.
		assert.deepEqual(at('2026-11-12T00:59:59Z'), offPeak);
		assert.deepEqual(at('2026-11-12T01:00:00Z'), peak);
		assert.deepEqual(at('2026-11-12T03:59:59Z'), peak);
		assert.deepEqual(at('2026-11-12T04:00:00Z'), offPeak);
		assert.deepEqual(at('2026-11-12T05:30:00Z'), offPeak);
		assert.deepEqual(at('2026-11-12T06:00:00Z'), peak);
		assert.deepEqual(at('2026-11-12T09:59:59Z'), peak);
		assert.deepEqual(at('2026-11-12T10:00:00Z'), offPeak);
		assert.deepEqual(at('2026-11-14T02:00:00Z'), offPeak, 'Saturday');
		assert.deepEqual(at('2026-11-15T07:00:00Z'), offPeak, 'Sunday');
		assert.deepEqual(at('2026-11-16T07:00:00Z'), peak, 'Monday');
		// 11:00 Thursday in Tokyo is 02:00 UTC: the day and hour are read in UTC whatever the local zone.
		assert.deepEqual(at('2026-11-12T11:00:00+09:00'), peak);
		near(costOf({ input: 2000, cacheRead: 8000, output: 30 }, at('2026-11-12T02:00:00Z')!), (2000 * 0.3 + 8000 * 0.006 + 30 * 1.2) / 1e6);
		near(costOf({ input: 2000, cacheRead: 8000, output: 30 }, at('2026-11-12T12:00:00Z')!), (2000 * 0.15 + 8000 * 0.003 + 30 * 0.6) / 1e6);
	});
});

describe('estimateTokens', () => {
	test('one per CJK character or mark, one per four others', () => {
		assert.equal(estimateTokens('他推开门，走了进去。'), 10);
		assert.equal(estimateTokens('He opened the door.'), 5);
		assert.equal(estimateTokens('他说 OK'), 3);
		assert.equal(estimateTokens(''), 0);
	});
});

describe('ledger', () => {
	const model = 'anthropic/claude-haiku-5-5';

	test('adds up per day and model; cancelled requests without usage only count as requests', () => {
		const ledger: Ledger = {};
		record(ledger, '2026-11-12', model, { input: 400, cacheRead: 6000, cacheWrite: 300, output: 20 }, 0.0001475);
		record(ledger, '2026-11-12', model, { input: 100, cacheRead: 6700, cacheWrite: 0, output: 8, outputEstimated: true }, 0.000081);
		record(ledger, '2026-11-12', model, {}, undefined);
		record(ledger, '2026-11-12', 'openaiCompatible/qwen3', { input: 900, output: 12 }, undefined);
		record(ledger, '2026-11-11', model, { input: 50, output: 5 }, 0.0000075);
		const today = totalsFor(ledger, '2026-11-12');
		assert.deepEqual(today[model], {
			requests: 3, unknown: 1, unpriced: 0, estimated: 1, input: 500, cacheRead: 12700, cacheWrite: 300, output: 28, cost: 0.0001475 + 0.000081,
		});
		assert.deepEqual(today['openaiCompatible/qwen3'], {
			requests: 1, unknown: 0, unpriced: 1, estimated: 0, input: 900, cacheRead: 0, cacheWrite: 0, output: 12, cost: 0,
		});
		const month = sum(totalsFor(ledger, '2026-11'));
		assert.equal(month.requests, 5);
		assert.equal(month.input, 1450);
		near(month.cost, 0.0001475 + 0.000081 + 0.0000075);
		assert.deepEqual(sum(totalsFor(ledger, '2026-12')), emptyTotals());
	});

	test('survives being saved and read back, as another window would', () => {
		const first: Ledger = {};
		record(first, '2026-11-12', model, { input: 10, output: 1 }, 0.001);
		const second = JSON.parse(JSON.stringify(first)) as Ledger;
		record(second, '2026-11-12', model, { input: 20, output: 2 }, 0.002);
		assert.equal(sum(totalsFor(second, '2026-11-12')).input, 30);
		near(sum(totalsFor(second, '2026-11-12')).cost, 0.003);
	});

	test('the daily limit compares against today alone', () => {
		const ledger: Ledger = {};
		const overLimit = (limit: number, day: string) => overDailyLimit(ledger, day, limit);
		record(ledger, '2026-11-11', model, { input: 1, output: 1 }, 0.9);
		record(ledger, '2026-11-12', model, { input: 1, output: 1 }, 0.3);
		assert.equal(overLimit(0.5, '2026-11-12'), false);
		record(ledger, '2026-11-12', model, { input: 1, output: 1 }, 0.2);
		assert.equal(overLimit(0.5, '2026-11-12'), true, 'reached');
		assert.equal(overLimit(0, '2026-11-12'), false, 'no limit');
		assert.equal(overLimit(0.5, '2026-11-13'), false, 'a new day starts from zero');
		record(ledger, '2026-11-13', 'openaiCompatible/qwen3', { input: 5_000_000, output: 5_000_000 }, undefined);
		assert.equal(overLimit(0.5, '2026-11-13'), false, 'requests without a price add no cost');
	});

	test('keeps this month and the last', () => {
		const ledger: Ledger = {};
		for (const day of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-12']) {
			record(ledger, day, model, { input: 1, output: 1 }, 0);
		}
		prune(ledger, new Date(2026, 10, 12));
		assert.deepEqual(Object.keys(ledger), ['2026-10-01', '2026-10-31', '2026-11-12']);
		const january: Ledger = { '2025-11-30': {}, '2025-12-01': {}, '2026-01-05': {} };
		prune(january, new Date(2026, 0, 5));
		assert.deepEqual(Object.keys(january), ['2025-12-01', '2026-01-05']);
	});

	test('days are local dates', () => {
		assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
		assert.equal(dayKey(new Date(2026, 10, 12, 0, 0)), '2026-11-12');
	});

	test('dollars', () => {
		assert.deepEqual(
			[dollars(0), dollars(0.0001475), dollars(0.0234), dollars(0.25), dollars(12.3456)],
			['$0.000000', '$0.000148', '$0.0234', '$0.2500', '$12.35'],
		);
	});
});
