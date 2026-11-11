import * as vscode from 'vscode';
import { renderReport, renderUsage, type RunRecord } from './core/report';
import { costOf, ratesFor } from './core/usage';
import { PROVIDERS, type ProviderId } from './llm/providers';
import { BookView } from './vscode/bookView';
import { SECTION, completionSettings, currentProvider, modelSettings, secretKey, usageSettings } from './vscode/config';
import { initWorkspace } from './vscode/init';
import { ContinuationProvider } from './vscode/inlineProvider';
import { LoreProviders } from './vscode/loreProviders';
import { LoreView } from './vscode/loreView';
import { SettingsView, selectProvider, setDailyLimit, setModel, toggleEnabled, toggleTrigger } from './vscode/settingsView';
import { StatusBar } from './vscode/statusBar';
import { UsageStore } from './storage/usageStore';
import { WorkspaceIndexes } from './vscode/workspaceIndex';

const REPORT_URI = vscode.Uri.from({ scheme: 'novel-helper', path: '/last-request.md' });
const USAGE_URI = vscode.Uri.from({ scheme: 'novel-helper', path: '/usage.md' });
const SELECTOR: vscode.DocumentFilter[] = ['markdown', 'plaintext'].flatMap((language) =>
	['file', 'untitled'].map((scheme) => ({ language, scheme })),
);

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Novel Helper', { log: true });
	const indexes = new WorkspaceIndexes(log);
	const usage = new UsageStore(context.globalStorageUri.fsPath);
	const status = new StatusBar(usage);
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
		recordUsage(run, used) {
			run.usage = used;
			if (run === lastRun) {
				reportChanged.fire(REPORT_URI);
			}
			usage
				.add(`${run.provider}/${run.model}`, used, run.rates && costOf(used, run.rates))
				.catch((error) => log.warn(`could not save usage: ${error instanceof Error ? error.message : String(error)}`));
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
	const showDocument = async (uri: vscode.Uri) => {
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
	};
	const usageDocument = (): string => {
		const model = modelSettings();
		const settings = usageSettings();
		return renderUsage(
			usage.current(),
			new Date(),
			{
				dailyLimit: settings.dailyLimitUsd,
				current: `${model.provider} · ${model.model}`,
				rates: ratesFor(model.model, new Date(), model.pricing, settings.prices),
			},
			vscode.l10n.t,
		);
	};
	// The sidebar's welcome text is for a folder with nothing of a novel in it; it waits for the first scan.
	const describeWorkspace = async () => {
		const all = await indexes.all();
		await vscode.commands.executeCommand('setContext', 'novelHelper.workspace', all.every((index) => index.library.empty) ? 'empty' : 'ready');
	};
	void usage.load();
	void describeWorkspace();

	context.subscriptions.push(
		log,
		indexes,
		status,
		new BookView(indexes),
		new LoreView(indexes),
		new SettingsView(context.secrets, usage),
		indexes.onDidChange(describeWorkspace),
		reportChanged,
		usage.onDidChange(() => reportChanged.fire(USAGE_URI)),
		vscode.languages.registerInlineCompletionItemProvider(SELECTOR, continuation),
		vscode.languages.registerHoverProvider(SELECTOR, lore),
		vscode.languages.registerDefinitionProvider(SELECTOR, lore),
		vscode.workspace.registerTextDocumentContentProvider(REPORT_URI.scheme, {
			onDidChange: reportChanged.event,
			provideTextDocumentContent: (uri) =>
				uri.path === USAGE_URI.path ? usageDocument() : renderReport(lastRun, vscode.l10n.t),
		}),
		vscode.commands.registerCommand('novelHelper.toggle', toggleEnabled),
		vscode.commands.registerCommand('novelHelper.toggleTrigger', toggleTrigger),
		vscode.commands.registerCommand('novelHelper.selectProvider', selectProvider),
		vscode.commands.registerCommand('novelHelper.setModel', setModel),
		vscode.commands.registerCommand('novelHelper.setDailyLimit', setDailyLimit),
		vscode.commands.registerCommand('novelHelper.init', () => initWorkspace(indexes)),
		vscode.commands.registerCommand('novelHelper.setApiKey', (provider?: ProviderId) =>
			setApiKey(context.secrets, provider),
		),
		vscode.commands.registerCommand('novelHelper.showLastRequest', () => showDocument(REPORT_URI)),
		vscode.commands.registerCommand('novelHelper.showUsage', async () => {
			await usage.load();
			await showDocument(USAGE_URI);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${SECTION}.files`)) {
				indexes.reset();
			}
			if (event.affectsConfiguration(`${SECTION}.enabled`) && !completionSettings().enabled) {
				continuation.cancelRunning();
				void vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
			}
			if (event.affectsConfiguration(SECTION)) {
				status.setProblem(undefined);
				reportChanged.fire(USAGE_URI);
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => indexes.reset(vscode.workspace.workspaceFolders ?? [])),
		// Renaming or deleting a folder (a volume, an arc) moves many files at once: index again on next use.
		vscode.workspace.onDidRenameFiles(() => indexes.reset()),
		vscode.workspace.onDidDeleteFiles(() => indexes.reset()),
		context.secrets.onDidChange(() => status.setProblem(undefined)),
	);
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
