import * as vscode from 'vscode';
import { dollars } from '../core/usage';
import { completionSettings, modelSettings, usageSettings } from './config';
import type { UsageStore } from './usageStore';

const PROSE_LANGUAGES = new Set(['markdown', 'plaintext']);

/** On / off / requesting indicator; clicking it toggles inline continuation. */
export class StatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('novelHelper.status', vscode.StatusBarAlignment.Right, 100);
	private running = 0;
	private problem?: string;
	private readonly disposables: vscode.Disposable[] = [this.item];

	constructor(private readonly usage: UsageStore) {
		this.item.name = vscode.l10n.t('Novel Helper');
		this.item.command = 'novelHelper.toggle';
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
			usage.onDidChange(() => this.update()),
		);
		this.update();
	}

	/** True when today's estimated cost has reached the daily limit: automatic requests stop. */
	overLimit(): boolean {
		return this.usage.overLimit(usageSettings().dailyLimitUsd);
	}

	private today(): string {
		const totals = this.usage.today();
		if (!totals.requests) {
			return vscode.l10n.t('Today: no requests yet.');
		}
		return vscode.l10n.t(
			'Today: {0} requests, input {1} + {2} read from cache + {3} written to cache, output {4}, about {5}.',
			totals.requests,
			totals.input,
			totals.cacheRead,
			totals.cacheWrite,
			totals.output,
			dollars(totals.cost),
		);
	}

	begin(): void {
		this.running++;
		this.update();
	}

	end(problem?: string): void {
		this.running = Math.max(0, this.running - 1);
		this.problem = problem;
		this.update();
	}

	setProblem(problem: string | undefined): void {
		this.problem = problem;
		this.update();
	}

	update(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !PROSE_LANGUAGES.has(editor.document.languageId)) {
			this.item.hide();
			return;
		}
		const { enabled, trigger } = completionSettings();
		const model = modelSettings();
		const label = vscode.l10n.t('Continue');
		const about = `${model.provider} · ${model.model || vscode.l10n.t('(no model set)')}`;
		let tooltip: string;
		if (!enabled) {
			this.item.text = `$(circle-slash) ${label}`;
			tooltip = vscode.l10n.t('Inline continuation is off. Click to turn it on.');
		} else if (this.running) {
			this.item.text = `$(loading~spin) ${label}`;
			tooltip = vscode.l10n.t('Asking {0}…', about);
		} else if (this.problem) {
			this.item.text = `$(warning) ${label}`;
			tooltip = `${this.problem}\n\n${vscode.l10n.t('Click to turn inline continuation off.')}`;
		} else if (this.overLimit()) {
			this.item.text = `$(warning) ${label}`;
			tooltip = [
				vscode.l10n.t(
					'Today\'s estimated cost has reached the daily limit of {0}: automatic requests have stopped until tomorrow. Alt+\\ still asks for one.',
					dollars(usageSettings().dailyLimitUsd),
				),
				vscode.l10n.t('Click to turn inline continuation off.'),
			].join('\n\n');
		} else {
			this.item.text = `$(sparkle) ${label}`;
			tooltip = [
				trigger === 'manual'
					? vscode.l10n.t('Inline continuation is on (manual: press Alt+\\).')
					: vscode.l10n.t('Inline continuation is on.'),
				about,
				vscode.l10n.t('Click to turn it off.'),
			].join('\n');
		}
		this.item.tooltip = `${tooltip}\n\n${this.today()}`;
		this.item.show();
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
