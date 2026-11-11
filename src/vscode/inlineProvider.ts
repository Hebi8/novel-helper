// Ghost-text continuation: waits for a pause, gathers context, asks the model,
// and shows the first sentence of its reply. Tab accepts (VS Code's own key).

import * as vscode from 'vscode';
import { buildContext, type ChapterSource } from '../core/context';
import type { RunRecord } from '../core/report';
import { Matcher } from '../core/match';
import { buildHttpRequest, complete } from '../llm/client';
import type { ProviderId } from '../llm/providers';
import { completionSettings, contextSettings, modelSettings, secretKey } from './config';
import type { StatusBar } from './statusBar';
import { readText, type WorkspaceIndexes } from './workspaceIndex';

/** Only closing punctuation or whitespace may follow the cursor for an automatic request. */
const LINE_END_REST = /^[\s」』”’）)】》〉"'。！？!?…]*$/;
/**
 * Lowercase letters right after Chinese text (or alone on the line) are most
 * likely pinyin still being composed in an input method; VS Code hides ghost
 * text during composition but would still send the request.
 */
const COMPOSING = /(^|[^\x00-\x7f])[a-z' ]*[a-z]$/;
/** For documents outside any workspace folder. */
const NO_LORE = new Matcher([]);

function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(true);
		}, ms);
		const subscription = token.onCancellationRequested(() => {
			clearTimeout(timer);
			subscription.dispose();
			resolve(false);
		});
	});
}

export interface ProviderHooks {
	indexes: WorkspaceIndexes;
	secrets: vscode.SecretStorage;
	status: StatusBar;
	log: vscode.LogOutputChannel;
	/** Called when a request finishes (not when it is cancelled). */
	recordRun(run: RunRecord): void;
	missingKey(provider: ProviderId): void;
}

export class ContinuationProvider implements vscode.InlineCompletionItemProvider {
	private lastShown?: { key: string; text: string };

	constructor(private readonly hooks: ProviderHooks) {}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const settings = completionSettings();
		const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
		if (!settings.enabled || (!manual && settings.trigger === 'manual')) {
			return undefined;
		}
		const located = await this.hooks.indexes.locate(document);
		const lineBefore = document.lineAt(position.line).text.slice(0, position.character);
		const lineAfter = document.lineAt(position.line).text.slice(position.character);
		if (!manual) {
			if (!located || !located.index.library.isChapter(located.path)) {
				return undefined;
			}
			if (!LINE_END_REST.test(lineAfter) || COMPOSING.test(lineBefore)) {
				return undefined;
			}
		}

		const text = document.getText();
		const offset = document.offsetAt(position);
		const before = text.slice(0, offset);
		const after = text.slice(offset);
		const key = `${document.uri.toString()}\n${before.slice(-500)}\n${after.slice(0, 200)}`;
		const item = (suggestion: string) => [new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position))];
		if (!manual) {
			if (this.lastShown?.key === key) {
				return item(this.lastShown.text);
			}
			if (!(await sleep(settings.debounceMs, token))) {
				return undefined;
			}
		}

		const model = modelSettings();
		const apiKey = await this.hooks.secrets.get(secretKey(model.provider));
		if (model.keyRequired && !apiKey) {
			this.hooks.missingKey(model.provider);
			return undefined;
		}

		const limits = contextSettings(document.uri);
		const library = located?.index.library;
		let outline: { path: string; content: string } | undefined;
		let previous: ChapterSource[] = [];
		if (located && library) {
			const read = (path: string) => readText(located.index.uri(path));
			const outlinePath = library.companionOf('outline', located.path);
			if (outlinePath) {
				outline = { path: outlinePath, content: await read(outlinePath) };
			}
			previous = await Promise.all(
				library.previousChapters(located.path, limits.previousChapters).map(async (path): Promise<ChapterSource> => {
					const summaryPath = library.companionOf('summary', path);
					return summaryPath ? { path, summary: await read(summaryPath) } : { path, text: await read(path) };
				}),
			);
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		const documentPath = located?.path ?? document.uri.path;
		const { prompt, trace } = buildContext({
			documentPath,
			before,
			after,
			entries: library?.entries() ?? [],
			matcher: library?.matcher() ?? NO_LORE,
			outline,
			previous,
			limits,
		});
		const request = { ...model, apiKey, ...prompt };
		const { url, body } = buildHttpRequest(request);
		const run: RunRecord = {
			time: new Date(),
			document: documentPath,
			line: position.line + 1,
			trigger: manual ? 'manual' : 'auto',
			provider: model.provider,
			model: model.model,
			trace,
			prompt,
			request: { url, body },
		};

		const controller = new AbortController();
		const cancel = token.onCancellationRequested(() => controller.abort());
		this.hooks.status.begin();
		const outcome = await complete(request, {
			signal: controller.signal,
			before,
			after: lineAfter,
			maxChars: settings.maxSuggestionChars,
		});
		cancel.dispose();
		this.hooks.status.end(outcome.status === 'error' ? outcome.error : undefined);
		if (outcome.status === 'cancelled') {
			return undefined;
		}
		run.outcome = outcome;
		this.hooks.recordRun(run);
		this.hooks.log.info(
			`${documentPath}:${run.line} ${model.provider}/${model.model} ${outcome.status}` +
				` ${outcome.totalMs} ms${outcome.error ? `: ${outcome.error}` : ''}`,
		);
		if (outcome.status !== 'ok' || token.isCancellationRequested) {
			return undefined;
		}
		this.lastShown = { key, text: outcome.text };
		return item(outcome.text);
	}
}
