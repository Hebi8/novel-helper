// Token usage of a request, what it cost at a provider's prices, and the
// running totals per day. Prices are US dollars per million tokens.

export interface Usage {
	/** Input tokens billed at the full input price: not read from a cache, not written to one. */
	input?: number;
	/** Input tokens read from the provider's prompt cache. */
	cacheRead?: number;
	/** Input tokens written to the provider's prompt cache. */
	cacheWrite?: number;
	output?: number;
	/** `output` was counted from the text received, because the connection closed before the provider reported it. */
	outputEstimated?: boolean;
}

export interface Rates {
	input: number;
	output: number;
	/** Defaults to the input price. */
	cacheRead?: number;
	/** Defaults to the input price. */
	cacheWrite?: number;
}

/** The prices of a provider's default model, as published on the day they were checked. */
export interface Pricing {
	model: string;
	rates: Rates;
	/** Higher prices on weekdays (Monday to Friday, UTC) during these hours, each `[from, to)`. */
	peak?: { rates: Rates; utcHours: ReadonlyArray<readonly [number, number]> };
}

/**
 * The prices that apply to `model` at `time`: the user's own for that model
 * if they set any, else the published ones when `model` is the one they are
 * for. Undefined when the price is not known.
 */
export function ratesFor(
	model: string,
	time: Date,
	pricing: Pricing | undefined,
	overrides: Readonly<Record<string, Rates>> = {},
): Rates | undefined {
	const own = overrides[model];
	if (own && typeof own.input === 'number' && typeof own.output === 'number') {
		return own;
	}
	if (pricing?.model !== model) {
		return undefined;
	}
	const day = time.getUTCDay();
	const hour = time.getUTCHours();
	const peak = pricing.peak && day >= 1 && day <= 5 && pricing.peak.utcHours.some(([from, to]) => hour >= from && hour < to);
	return peak ? pricing.peak!.rates : pricing.rates;
}

/** Dollars for one request; undefined when the input or output count is missing. */
export function costOf(usage: Usage, rates: Rates): number | undefined {
	if (usage.input === undefined || usage.output === undefined) {
		return undefined;
	}
	return (
		(usage.input * rates.input +
			(usage.cacheRead ?? 0) * (rates.cacheRead ?? rates.input) +
			(usage.cacheWrite ?? 0) * (rates.cacheWrite ?? rates.input) +
			usage.output * rates.output) /
		1_000_000
	);
}

/**
 * A rough token count for text whose real count never arrived: one per CJK
 * character, one per four other characters. Only ever shown marked as an estimate.
 */
export function estimateTokens(text: string): number {
	const cjk = text.match(/[⺀-鿿가-힯豈-﫿＀-￯]/g)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

export interface Totals {
	/** Requests the provider started working on, cancelled ones included. */
	requests: number;
	/** Of those, requests that ended before the provider reported any usage; they add nothing to the counts below. */
	unknown: number;
	/** Requests with usage but no known price; they add tokens but no cost. */
	unpriced: number;
	/** Requests whose output count is an estimate. */
	estimated: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
}

export function emptyTotals(): Totals {
	return { requests: 0, unknown: 0, unpriced: 0, estimated: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
}

function addTotals(into: Totals, from: Totals): void {
	for (const key of Object.keys(from) as Array<keyof Totals>) {
		into[key] += from[key];
	}
}

/**
 * Totals per day (`YYYY-MM-DD`, local time), then per `provider/model`.
 * Requests that are not continuations are kept apart: their key has `#` and
 * what they were for after the model.
 */
export type Ledger = Record<string, Record<string, Totals>>;

/** What a request was for, when not a continuation: finding the chapter's place on the outline. */
export type UsageKind = 'position';

export function usageKey(provider: string, model: string, kind?: UsageKind): string {
	return `${provider}/${model}${kind ? `#${kind}` : ''}`;
}

export function splitUsageKey(key: string): { model: string; kind?: string } {
	const hash = key.lastIndexOf('#');
	return hash === -1 ? { model: key } : { model: key.slice(0, hash), kind: key.slice(hash + 1) };
}

export function dayKey(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Adds one request to the ledger. `cost` is undefined when the price is not known. */
export function record(ledger: Ledger, day: string, model: string, usage: Usage, cost: number | undefined): void {
	const totals = ((ledger[day] ??= {})[model] ??= emptyTotals());
	totals.requests++;
	if (usage.input === undefined) {
		totals.unknown++;
		return;
	}
	totals.input += usage.input;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.output += usage.output ?? 0;
	if (usage.outputEstimated) {
		totals.estimated++;
	}
	if (cost === undefined) {
		totals.unpriced++;
	} else {
		totals.cost += cost;
	}
}

/** Totals per `provider/model` over the days that start with `prefix`: a day, or a month (`YYYY-MM`). */
export function totalsFor(ledger: Ledger, prefix: string): Record<string, Totals> {
	const out: Record<string, Totals> = {};
	for (const [day, models] of Object.entries(ledger)) {
		if (!day.startsWith(prefix)) {
			continue;
		}
		for (const [model, totals] of Object.entries(models)) {
			addTotals((out[model] ??= emptyTotals()), totals);
		}
	}
	return out;
}

export function sum(byModel: Record<string, Totals>): Totals {
	const all = emptyTotals();
	Object.values(byModel).forEach((totals) => addTotals(all, totals));
	return all;
}

/** Whether the day's estimated cost has reached the limit; a limit of 0 is no limit. */
export function overDailyLimit(ledger: Ledger, day: string, limit: number): boolean {
	return limit > 0 && sum(totalsFor(ledger, day)).cost >= limit;
}

/** Drops the days before the month before `today`'s. */
export function prune(ledger: Ledger, today: Date): void {
	const keepFrom = dayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1));
	for (const day of Object.keys(ledger)) {
		if (day < keepFrom) {
			delete ledger[day];
		}
	}
}

/** `$12.35`, `$0.0234`, `$0.000148`: enough digits to see a single cheap request. */
export function dollars(amount: number): string {
	return `$${amount.toFixed(amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6)}`;
}
