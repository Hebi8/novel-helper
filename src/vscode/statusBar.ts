import * as vscode from 'vscode';
import { completionSettings, modelSettings } from './config';

const PROSE_LANGUAGES = new Set(['markdown', 'plaintext']);

/** On / off / requesting indicator; clicking it toggles inline continuation. */
export class StatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('novelHelper.status', vscode.StatusBarAlignment.Right, 100);
	private running = 0;
	private problem?: string;
	private readonly disposables: vscode.Disposable[] = [this.item];

	constructor() {
		this.item.name = vscode.l10n.t('Novel Helper');
		this.item.command = 'novelHelper.toggle';
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.update()));
		this.update();
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
		if (!enabled) {
			this.item.text = `$(circle-slash) ${label}`;
			this.item.tooltip = vscode.l10n.t('Inline continuation is off. Click to turn it on.');
		} else if (this.running) {
			this.item.text = `$(loading~spin) ${label}`;
			this.item.tooltip = vscode.l10n.t('Asking {0}…', about);
		} else if (this.problem) {
			this.item.text = `$(warning) ${label}`;
			this.item.tooltip = `${this.problem}\n\n${vscode.l10n.t('Click to turn inline continuation off.')}`;
		} else {
			this.item.text = `$(sparkle) ${label}`;
			this.item.tooltip = [
				trigger === 'manual'
					? vscode.l10n.t('Inline continuation is on (manual: press Alt+\\).')
					: vscode.l10n.t('Inline continuation is on.'),
				about,
				vscode.l10n.t('Click to turn it off.'),
			].join('\n');
		}
		this.item.show();
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
