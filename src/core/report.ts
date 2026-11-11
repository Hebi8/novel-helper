// Renders the "what was sent to the model" document for the last request.

import type { CompletionOutcome, HttpRequest } from '../llm/client';
import type { ContextTrace, Prompt, SkippedEntry, UsedEntry } from './context';
import type { Hit } from './match';
import { fenced } from './text';

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
		out.push(t('None: no entry is always on and no name was found near the cursor.'));
	}
	out.push('', t('Budgets: always-on {0} chars, matched {1} chars, {2} chars per entry.', trace.limits.alwaysChars, trace.limits.matchedChars, trace.limits.entryChars), '');

	if (trace.skipped.length) {
		out.push(`## ${t('Left out: over budget ({0})', trace.skipped.length)}`, '');
		out.push(`| ${t('Entry')} | ${t('Type')} | ${t('Why')} | ${t('Chars')} |`, '|---|---|---|---|');
		out.push(...trace.skipped.map((e) => skippedRow(e, t)), '');
	}

	out.push(`## ${t('Outline and previous chapters')}`, '');
	out.push(
		trace.outline
			? `- ${t('Outline: {0}, {1} chars', trace.outline.path, chars(trace.outline.chars, trace.outline.truncated, t))}`
			: `- ${t('Outline: none found for this file')}`,
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
	out.push(`- ${t('Names searched in the last {0} chars before the cursor', trace.scannedChars)}`, '');

	out.push(`## ${t('Prompt')}`, '');
	out.push(`### ${t('System')}`, '', fenced(prompt.system), '');
	if (prompt.stable) {
		out.push(`### ${t('User: part that stays the same within a chapter')}`, '', fenced(prompt.stable), '');
	}
	out.push(`### ${t('User: part that changes with every request')}`, '', fenced(prompt.dynamic), '');
	const { system: _system, messages: _messages, ...params } = run.request.body;
	out.push(`### ${t('Request parameters')}`, '', `${t('POST {0}', run.request.url)}`, '', fenced(JSON.stringify(params, null, 2), 'json'), '');

	out.push(`## ${t('Model reply (raw)')}`, '', fenced(outcome?.raw ?? ''), '');
	out.push(`## ${t('Ghost text')}`, '', fenced(outcome?.text ?? ''), '');
	return out.join('\n');
}
