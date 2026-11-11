// Renders the "what was sent to the model" document for the last request, and
// the usage totals.

import type { CompletionOutcome, HttpRequest } from '../llm/client';
import type { ContextTrace, Prompt, SkippedEntry, UsedEntry } from './context';
import type { Hit } from './match';
import { fenced } from './text';
import { costOf, dayKey, dollars, type Ledger, type Rates, sum, type Totals, totalsFor, type Usage } from './usage';

/** `vscode.l10n.t`-compatible: `{0}`, `{1}` … are replaced by the arguments. */
export type Translate = (message: string, ...args: Array<string | number>) => string;

export interface RunRecord {
	time: Date;
	document: string;
	line: number;
	trigger: 'auto' | 'manual';
	provider: string;
	model: string;
	trace: ContextTrace;
	prompt: Prompt;
	/** URL and body only: headers carry the API key and are never kept. */
	request: Omit<HttpRequest, 'headers'>;
	/** Undefined while the request is running. */
	outcome?: CompletionOutcome;
	/** What the provider reported; set once the connection is closed, which can be after `outcome`. */
	usage?: Usage;
	/** The prices at the time of the request; undefined when they are not known for this model. */
	rates?: Rates;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function timestamp(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function why(hit: Hit, t: Translate): string {
	const parts: string[] = [];
	if (hit.count) {
		const keys = [...hit.keys].map(([key, n]) => `「${key}」×${n}`).join(t(', '));
		parts.push(t('{0}; nearest {1} chars before the cursor', keys, hit.nearest ?? 0));
	}
	if (hit.inOutline) {
		parts.push(t('named in the outline'));
	}
	return parts.join(t('; '));
}

function chars(n: number, truncated: boolean, t: Translate): string {
	return truncated ? t('{0} (cut)', n) : String(n);
}

function usedRow(e: UsedEntry, t: Translate): string {
	const reason = e.hit ? why(e.hit, t) : t('always on');
	const source = e.source === 'summary' ? t('summary') : t('body');
	return `| ${cell(e.name)} | ${cell(e.type ?? '')} | ${cell(reason)} | ${chars(e.chars, e.truncated, t)} | ${source} |`;
}

function skippedRow(e: SkippedEntry, t: Translate): string {
	const reason = e.hit ? why(e.hit, t) : t('always on');
	return `| ${cell(e.name)} | ${cell(e.type ?? '')} | ${cell(reason)} | ${e.chars} |`;
}

function result(outcome: CompletionOutcome | undefined, t: Translate): string {
	switch (outcome?.status) {
		case undefined:
			return t('still running');
		case 'ok':
			return t('shown as ghost text');
		case 'empty':
			return t('not shown: the reply was empty');
		case 'meta':
			return t('not shown: the reply talked about the task instead of continuing the text');
		case 'cancelled':
			return t('cancelled: you kept typing');
		case 'error':
			return t('error: {0}', outcome.error ?? '');
	}
}

function timing(outcome: CompletionOutcome | undefined, t: Translate): string {
	if (!outcome) {
		return '';
	}
	const first = outcome.firstTokenMs === undefined ? '' : t('first text after {0} ms, ', outcome.firstTokenMs);
	const early = outcome.stoppedEarly ? t(' (stopped once the first sentence arrived)') : '';
	return `${first}${t('{0} ms in total', outcome.totalMs)}${early}`;
}

function prices(rates: Rates, t: Translate): string {
	return t(
		'input {0}, cache read {1}, cache write {2}, output {3} (US dollars per million tokens)',
		rates.input,
		rates.cacheRead ?? rates.input,
		rates.cacheWrite ?? rates.input,
		rates.output,
	);
}

function usageLines(run: RunRecord, t: Translate): string[] {
	const { usage, rates } = run;
	if (!usage) {
		return [run.outcome?.status === 'error' ? t('None: the request failed.') : t('Waiting for the provider to report it.')];
	}
	if (usage.input === undefined) {
		return [t('Unknown: the connection was closed before the provider reported it.')];
	}
	const cost = rates && costOf(usage, rates);
	const output = usage.outputEstimated
		? t('about {0} (estimated from the text received: the connection was closed before the provider reported it)', usage.output ?? 0)
		: String(usage.output ?? 0);
	return [
		'| | |',
		'|---|---|',
		`| ${t('Input at full price')} | ${usage.input} |`,
		`| ${t('Input read from cache')} | ${usage.cacheRead ?? t('not reported')} |`,
		`| ${t('Input written to cache')} | ${usage.cacheWrite ?? t('not reported')} |`,
		`| ${t('Output')} | ${output} |`,
		`| ${t('Estimated cost')} | ${cost === undefined ? t('unknown: no price for this model; set `novelHelper.usage.prices`') : dollars(cost)} |`,
		...(rates ? [`| ${t('Prices')} | ${prices(rates, t)} |`] : []),
	];
}

export function renderReport(run: RunRecord | undefined, t: Translate): string {
	if (!run) {
		return `# ${t('Nothing sent yet')}\n\n${t('Pause at the end of a line in a chapter file, or press Alt+\\ in any Markdown or plain-text file, then open this again.')}\n`;
	}
	const { trace, prompt, outcome } = run;
	const out: string[] = [];
	out.push(`# ${t('Last request to the model')}`, '');
	out.push(`| | |`, `|---|---|`);
	out.push(`| ${t('Time')} | ${timestamp(run.time)} |`);
	out.push(`| ${t('File')} | ${cell(t('{0}, line {1}', run.document, run.line))} |`);
	out.push(`| ${t('Trigger')} | ${run.trigger === 'auto' ? t('automatic') : t('manual')} |`);
	out.push(`| ${t('Model')} | ${cell(`${run.provider} · ${run.model}`)} |`);
	out.push(`| ${t('Result')} | ${cell(result(outcome, t))} |`);
	if (outcome) {
		out.push(`| ${t('Time taken')} | ${timing(outcome, t)} |`);
	}
	out.push('');

	const used = [...trace.always, ...trace.matched];
	const usedChars = used.reduce((sum, e) => sum + e.chars, 0);
	out.push(`## ${t('Entries used ({0}, {1} chars)', used.length, usedChars)}`, '');
	if (used.length) {
		out.push(`| ${t('Entry')} | ${t('Type')} | ${t('Why')} | ${t('Chars')} | ${t('From')} |`, '|---|---|---|---|---|');
		out.push(...used.map((e) => usedRow(e, t)));
	} else {
		out.push(t('None: no entry is always on and no name was found in the text before the cursor.'));
	}
	out.push('', t('Budgets: always-on {0} chars, matched {1} chars, {2} chars per entry.', trace.limits.alwaysChars, trace.limits.matchedChars, trace.limits.entryChars), '');

	if (trace.skipped.length) {
		out.push(`## ${t('Left out: over budget ({0})', trace.skipped.length)}`, '');
		out.push(`| ${t('Entry')} | ${t('Type')} | ${t('Why')} | ${t('Chars')} |`, '|---|---|---|---|');
		out.push(...trace.skipped.map((e) => skippedRow(e, t)), '');
	}

	out.push(`## ${t('Outlines and previous chapters')}`, '');
	for (const level of trace.levels) {
		const size = chars(level.chars, level.truncated, t);
		if (level.book) {
			out.push(`- ${level.path ? t('Outline of the whole book: {0}, {1} chars', level.path, size) : t('Outline of the whole book: none')}`);
		} else {
			out.push(`- ${level.path ? t('Outline of {0}: {1}, {2} chars', level.name, level.path, size) : t('Outline of {0}: none', level.name)}`);
		}
	}
	out.push(
		trace.outline
			? `- ${t('Outline of this chapter: {0}, {1} chars', trace.outline.path, chars(trace.outline.chars, trace.outline.truncated, t))}`
			: `- ${t('Outline of this chapter: none')}`,
	);
	if (trace.previous.length) {
		for (const p of trace.previous) {
			const kind = p.source === 'summary' ? t('summary') : t('ending (no summary)');
			out.push(`- ${t('{0}: {1}, {2} chars', p.path, kind, chars(p.chars, p.truncated, t))}`);
		}
	} else {
		out.push(`- ${t('Previous chapters: none (not a chapter file, or the first chapter)')}`);
	}
	out.push('');

	out.push(`## ${t('Text around the cursor')}`, '');
	out.push(`- ${t('Before the cursor: {0} chars', chars(trace.before.chars, trace.before.truncated, t))}`);
	out.push(`- ${t('After the cursor: {0} chars', chars(trace.after.chars, trace.after.truncated, t))}`);
	out.push(`- ${t('Names are searched in the text before the cursor that is sent.')}`, '');

	out.push(`## ${t('Tokens and cost')}`, '', ...usageLines(run, t), '');

	// The user message, cut where the cache breakpoints are.
	const parts: Array<{ text: string; cache: boolean }> = [];
	for (const block of prompt.user) {
		const last = parts[parts.length - 1];
		if (last && !last.cache) {
			last.text += block.text;
			last.cache = block.cache;
		} else {
			parts.push({ ...block });
		}
	}
	const total = prompt.system.length + parts.reduce((n, part) => n + part.text.length, 0);
	const reusable = parts.some((part) => part.cache)
		? total - parts.filter((part) => !part.cache).reduce((n, part) => n + part.text.length, 0)
		: prompt.system.length;
	out.push(`## ${t('Prompt')}`, '');
	out.push(t('{0} chars in all, {1} of them before the last cache breakpoint: a request that follows within the cache lifetime pays about a tenth for the part it shares with this one.', total, reusable), '');
	out.push(`### ${t('System')}`, '', fenced(prompt.system), '');
	parts.forEach((part, index) => {
		const title = t('User message, part {0} of {1}', index + 1, parts.length);
		out.push(`### ${part.cache ? t('{0} (cache breakpoint after it)', title) : title}`, '', fenced(part.text), '');
	});
	const { system: _system, messages: _messages, ...params } = run.request.body;
	out.push(`### ${t('Request parameters')}`, '', `${t('POST {0}', run.request.url)}`, '', fenced(JSON.stringify(params, null, 2), 'json'), '');

	out.push(`## ${t('Model reply (raw)')}`, '', fenced(outcome?.raw ?? ''), '');
	out.push(`## ${t('Ghost text')}`, '', fenced(outcome?.text ?? ''), '');
	return out.join('\n');
}

function totalsRow(label: string, totals: Totals): string {
	return `| ${cell(label)} | ${totals.requests} | ${totals.input} | ${totals.cacheRead} | ${totals.cacheWrite} | ${totals.output} | ${dollars(totals.cost)} |`;
}

function totalsTable(byModel: Record<string, Totals>, t: Translate): string[] {
	const models = Object.keys(byModel).sort();
	if (!models.length) {
		return [t('No requests.'), ''];
	}
	const all = sum(byModel);
	const out = [
		`| ${t('Provider / model')} | ${t('Requests')} | ${t('Input at full price')} | ${t('Input read from cache')} | ${t('Input written to cache')} | ${t('Output')} | ${t('Estimated cost')} |`,
		'|---|---:|---:|---:|---:|---:|---:|',
		...models.map((model) => totalsRow(model, byModel[model])),
		...(models.length > 1 ? [totalsRow(t('Total'), all)] : []),
		'',
	];
	const input = all.input + all.cacheRead + all.cacheWrite;
	if (input) {
		out.push(`- ${t('{0}% of the input tokens were read from cache.', Math.round((all.cacheRead / input) * 100))}`);
	}
	if (all.unknown) {
		out.push(`- ${t('{0} requests ended before the provider reported usage: they are in the request count, not in the tokens or the cost.', all.unknown)}`);
	}
	if (all.unpriced) {
		out.push(`- ${t('{0} requests used a model with no known price: their tokens are counted, their cost is not.', all.unpriced)}`);
	}
	if (all.estimated) {
		out.push(`- ${t('The output of {0} requests is estimated from the text received.', all.estimated)}`);
	}
	if (out[out.length - 1] !== '') {
		out.push('');
	}
	return out;
}

export interface UsageInfo {
	/** Dollars a day after which automatic requests stop; 0 for no limit. */
	dailyLimit: number;
	/** `provider · model` in use now, and its prices if they are known. */
	current: string;
	rates?: Rates;
}

/** The "usage and estimated cost" document: today and this month, per provider and model. */
export function renderUsage(ledger: Ledger, now: Date, info: UsageInfo, t: Translate): string {
	const day = dayKey(now);
	const month = day.slice(0, 7);
	const out: string[] = [`# ${t('Usage and estimated cost')}`, ''];
	out.push(`## ${t('Today ({0})', day)}`, '', ...totalsTable(totalsFor(ledger, day), t));
	out.push(`## ${t('This month ({0})', month)}`, '', ...totalsTable(totalsFor(ledger, month), t));
	out.push(`## ${t('How this is counted')}`, '');
	out.push(`- ${t('Token counts are what the provider reported for each request, cancelled ones included. Requests the provider refused are not counted.')}`);
	out.push(`- ${t('Cost is tokens times the prices below. It is an estimate: the provider\'s bill is what counts.')}`);
	out.push(`- ${info.rates ? t('{0}: {1}.', info.current, prices(info.rates, t)) : t('{0}: no known price, so no cost is counted. Set `novelHelper.usage.prices` to add one.', info.current)}`);
	out.push(
		`- ${info.dailyLimit > 0 ? t('Daily limit: {0}. Once today\'s estimated cost reaches it, automatic requests stop until tomorrow; Alt+\\ still works.', dollars(info.dailyLimit)) : t('Daily limit: none. Set `novelHelper.usage.dailyLimitUsd` to stop automatic requests once a day\'s estimated cost reaches it.')}`,
	);
	out.push(`- ${t('The totals are kept on the machine the extension runs on, for this month and the last, and shared by all windows.')}`, '');
	return out.join('\n');
}
