// The sidebar's short list of the settings a writer changes now and then,
// with today's and this month's usage. One row each; clicking a row changes
// it. The API key is never shown, only whether one is saved.

import * as vscode from 'vscode';
import { isUsable, type StoryState } from '../core/story';
import { dollars, type Totals } from '../core/usage';
import { PROVIDERS } from '../llm/providers';
import type { UsageStore } from '../storage/usageStore';
import { SECTION, completionSettings, currentProvider, modelSettings, secretKey, updateSetting, usageSettings } from './config';
import { storyLabel } from './story';
import type { WorkspaceIndexes } from './workspaceIndex';

interface Row {
	id: string;
	label: string;
	description: string;
	icon: string;
	command: string;
	arguments?: unknown[];
	tooltip?: string;
}

export async function toggleEnabled(): Promise<void> {
	await updateSetting('enabled', !completionSettings().enabled);
}

export async function toggleTrigger(): Promise<void> {
	await updateSetting('trigger', completionSettings().trigger === 'auto' ? 'manual' : 'auto');
}

export async function selectProvider(): Promise<void> {
	const current = currentProvider();
	const pick = await vscode.window.showQuickPick(
		Object.values(PROVIDERS).map((p) => ({
			label: p.label,
			description: p.id === current ? vscode.l10n.t('current provider') : undefined,
			id: p.id,
		})),
		{ title: vscode.l10n.t('Provider'), placeHolder: vscode.l10n.t('Where should requests go? Each provider has its own model and API key.') },
	);
	if (pick && pick.id !== current) {
		await updateSetting('provider', pick.id);
	}
}

export async function setModel(): Promise<void> {
	const { provider, model } = modelSettings();
	const preset = PROVIDERS[provider];
	const value = await vscode.window.showInputBox({
		title: vscode.l10n.t('Model for {0}', preset.label),
		prompt: preset.defaultModel
			? vscode.l10n.t('The model id as the provider writes it. Empty goes back to the default, {0}.', preset.defaultModel)
			: vscode.l10n.t('The model id as the provider writes it.'),
		value: model,
	});
	if (value !== undefined) {
		const id = value.trim();
		// The default is not written down, so that a later version's default applies.
		await updateSetting(`${provider}.model`, id && id !== preset.defaultModel ? id : undefined);
	}
}

export async function setDailyLimit(): Promise<void> {
	const { dailyLimitUsd } = usageSettings();
	const value = await vscode.window.showInputBox({
		title: vscode.l10n.t('Daily limit'),
		prompt: vscode.l10n.t('US dollars a day after which automatic requests stop until tomorrow. 0 or empty for no limit.'),
		value: dailyLimitUsd ? String(dailyLimitUsd) : '',
		validateInput: (text) => (text.trim() && !(Number(text) >= 0) ? vscode.l10n.t('Type a number, like 0.5.') : undefined),
	});
	if (value !== undefined) {
		await updateSetting('usage.dailyLimitUsd', Number(value) || undefined);
	}
}

export class SettingsView implements vscode.TreeDataProvider<Row>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[];

	constructor(
		private readonly indexes: WorkspaceIndexes,
		private readonly secrets: vscode.SecretStorage,
		private readonly usage: UsageStore,
	) {
		this.disposables = [
			this.changed,
			vscode.window.registerTreeDataProvider('novelHelper.settings', this),
			indexes.onDidChange(() => this.changed.fire()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(SECTION)) {
					this.changed.fire();
				}
			}),
			secrets.onDidChange(() => this.changed.fire()),
			usage.onDidChange(() => this.changed.fire()),
		];
	}

	async getChildren(row?: Row): Promise<Row[]> {
		if (row) {
			return [];
		}
		const t = vscode.l10n.t;
		const { enabled, trigger } = completionSettings();
		const model = modelSettings();
		const preset = PROVIDERS[model.provider];
		const hasKey = (await this.secrets.get(secretKey(model.provider))) !== undefined;
		const { dailyLimitUsd } = usageSettings();
		const spent = (totals: Totals) =>
			totals.requests ? t('{0} requests, about {1}', totals.requests, dollars(totals.cost)) : t('no requests yet');
		const states: Record<StoryState, string> = {
			ready: t('initialized'),
			unmarked: t('in use, no marker'),
			empty: t('not initialized'),
			missing: t('does not exist'),
			invalid: t('not a path inside the workspace folder'),
		};
		const indexes = await this.indexes.all();
		// One per workspace folder: each has its own story folder.
		const stories = indexes.map((index): Row => ({
			id: `story:${index.folder.uri.toString()}`,
			label: indexes.length > 1 ? t('Story folder of {0}', index.folder.name) : t('Story folder'),
			description: `${index.story === undefined ? index.storySetting : storyLabel(index.story)} · ${states[index.state]}`,
			icon: isUsable(index.state) ? 'book' : 'warning',
			command: 'novelHelper.selectStoryFolder',
			arguments: [index.folder],
			tooltip: t('Where the story is inside the workspace folder. Click to switch to another story folder, pick or type one, or go back to the workspace folder itself.'),
		}));
		return [
			...stories,
			{
				id: 'enabled',
				label: t('Inline continuation'),
				description: enabled ? t('on') : t('off'),
				icon: enabled ? 'sparkle' : 'circle-slash',
				command: 'novelHelper.toggle',
				tooltip: t('Click to switch the ghost text on or off.'),
			},
			{
				id: 'trigger',
				label: t('Trigger'),
				description: trigger === 'auto' ? t('automatic, after a pause') : t('manual, on Alt+\\'),
				icon: 'zap',
				command: 'novelHelper.toggleTrigger',
				tooltip: t('Click to switch between automatic and manual.'),
			},
			{
				id: 'provider',
				label: t('Provider'),
				description: preset.label,
				icon: 'cloud',
				command: 'novelHelper.selectProvider',
				tooltip: t('Click to pick another provider.'),
			},
			{
				id: 'model',
				label: t('Model'),
				description: model.model || t('(no model set)'),
				icon: 'symbol-method',
				command: 'novelHelper.setModel',
				tooltip: t('Click to type another model id.'),
			},
			{
				id: 'key',
				label: t('API key'),
				description: hasKey ? t('saved') : preset.keyRequired ? t('not set') : t('not set (this provider may not need one)'),
				icon: hasKey ? 'key' : 'warning',
				command: 'novelHelper.setApiKey',
				arguments: [model.provider],
				tooltip: t('Click to set, replace or clear the key for {0}. The key itself is never shown.', preset.label),
			},
			{
				id: 'today',
				label: t('Today'),
				description: spent(this.usage.today()),
				icon: 'graph',
				command: 'novelHelper.showUsage',
				tooltip: t('Click for the usage in detail.'),
			},
			{
				id: 'month',
				label: t('This month'),
				description: spent(this.usage.month()),
				icon: 'calendar',
				command: 'novelHelper.showUsage',
				tooltip: t('Click for the usage in detail.'),
			},
			{
				id: 'limit',
				label: t('Daily limit'),
				description: dailyLimitUsd ? dollars(dailyLimitUsd) : t('none'),
				icon: 'shield',
				command: 'novelHelper.setDailyLimit',
				tooltip: t('Click to change it. Automatic requests stop for the day once the estimated cost reaches it.'),
			},
			{
				id: 'last',
				label: t('What was last sent to the model'),
				description: '',
				icon: 'output',
				command: 'novelHelper.showLastRequest',
			},
			{
				id: 'all',
				label: t('All settings'),
				description: '',
				icon: 'gear',
				command: 'workbench.action.openSettings',
				arguments: ['@ext:dreaife.novel-helper'],
			},
		];
	}

	getTreeItem(row: Row): vscode.TreeItem {
		const item = new vscode.TreeItem(row.label);
		item.id = row.id;
		item.description = row.description;
		item.iconPath = new vscode.ThemeIcon(row.icon);
		item.tooltip = row.tooltip;
		item.command = { command: row.command, title: row.label, arguments: row.arguments };
		return item;
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
