import * as vscode from 'vscode';
import { renderReport, type RunRecord } from './core/report';
import { PROVIDERS, type ProviderId } from './llm/providers';
import { SECTION, completionSettings, currentProvider, secretKey } from './vscode/config';
import { ContinuationProvider } from './vscode/inlineProvider';
import { LoreProviders } from './vscode/loreProviders';
import { StatusBar } from './vscode/statusBar';
import { WorkspaceIndexes } from './vscode/workspaceIndex';

const REPORT_URI = vscode.Uri.from({ scheme: 'novel-helper', path: '/last-request.md' });
const SELECTOR: vscode.DocumentFilter[] = ['markdown', 'plaintext'].flatMap((language) =>
	['file', 'untitled'].map((scheme) => ({ language, scheme })),
);

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Novel Helper', { log: true });
	const indexes = new WorkspaceIndexes(log);
	const status = new StatusBar();
	const reportChanged = new vscode.EventEmitter<vscode.Uri>();
	const askedForKey = new Set<ProviderId>();
	let lastRun: RunRecord | undefined;

	const continuation = new ContinuationProvider({
		indexes,
		secrets: context.secrets,
		status,
		log,
		recordRun(run) {
			lastRun = run;
			reportChanged.fire(REPORT_URI);
		},
		missingKey(provider) {
			const label = PROVIDERS[provider].label;
			status.setProblem(vscode.l10n.t('No API key set for {0}. Run "Novel Helper: Set or Clear API Key".', label));
			if (askedForKey.has(provider)) {
				return;
			}
			askedForKey.add(provider);
			const action = vscode.l10n.t('Set API Key');
			void vscode.window
				.showWarningMessage(vscode.l10n.t('Novel Helper needs an API key for {0} to suggest text.', label), action)
				.then((choice) => {
					if (choice === action) {
						void vscode.commands.executeCommand('novelHelper.setApiKey', provider);
					}
				});
		},
	});
	const lore = new LoreProviders(indexes);

	context.subscriptions.push(
		log,
		indexes,
		status,
		reportChanged,
		vscode.languages.registerInlineCompletionItemProvider(SELECTOR, continuation),
		vscode.languages.registerHoverProvider(SELECTOR, lore),
		vscode.languages.registerDefinitionProvider(SELECTOR, lore),
		vscode.workspace.registerTextDocumentContentProvider(REPORT_URI.scheme, {
			onDidChange: reportChanged.event,
			provideTextDocumentContent: () => renderReport(lastRun, vscode.l10n.t),
		}),
		vscode.commands.registerCommand('novelHelper.toggle', toggle),
		vscode.commands.registerCommand('novelHelper.setApiKey', (provider?: ProviderId) =>
			setApiKey(context.secrets, provider),
		),
		vscode.commands.registerCommand('novelHelper.showLastRequest', async () => {
			const document = await vscode.workspace.openTextDocument(REPORT_URI);
			await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${SECTION}.files`)) {
				indexes.reset();
			}
			if (event.affectsConfiguration(SECTION)) {
				status.setProblem(undefined);
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => indexes.reset(vscode.workspace.workspaceFolders ?? [])),
		context.secrets.onDidChange(() => status.setProblem(undefined)),
	);
}

async function toggle(): Promise<void> {
	const config = vscode.workspace.getConfiguration(SECTION);
	const target =
		config.inspect<boolean>('enabled')?.workspaceValue !== undefined
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
	await config.update('enabled', !completionSettings().enabled, target);
}

async function setApiKey(secrets: vscode.SecretStorage, preselected?: ProviderId): Promise<void> {
	let provider = preselected;
	if (!provider) {
		const current = currentProvider();
		const items = Object.values(PROVIDERS)
			.map((p) => ({
				label: p.label,
				description: p.id === current ? vscode.l10n.t('current provider') : undefined,
				id: p.id,
			}))
			.sort((a, b) => Number(b.id === current) - Number(a.id === current));
		const pick = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Set or Clear API Key'),
			placeHolder: vscode.l10n.t('Which provider is this key for?'),
		});
		if (!pick) {
			return;
		}
		provider = pick.id;
	}
	const key = secretKey(provider);
	const label = PROVIDERS[provider].label;
	const saved = (await secrets.get(key)) !== undefined;
	const value = await vscode.window.showInputBox({
		title: vscode.l10n.t('API key for {0}', label),
		prompt: saved
			? vscode.l10n.t('A key is saved. Paste a new one to replace it, or leave this empty and press Enter to clear it.')
			: vscode.l10n.t('The key is kept in VS Code secret storage, not in settings.'),
		placeHolder: saved ? vscode.l10n.t('Empty clears the saved key') : vscode.l10n.t('Paste the key'),
		password: true,
		ignoreFocusOut: true,
	});
	if (value === undefined) {
		return;
	}
	if (!value.trim()) {
		if (saved) {
			await secrets.delete(key);
			void vscode.window.showInformationMessage(vscode.l10n.t('Cleared the API key for {0}.', label));
		}
		return;
	}
	await secrets.store(key, value.trim());
	void vscode.window.showInformationMessage(vscode.l10n.t('Saved the API key for {0}.', label));
}

export function deactivate(): void {}
