// Pull-style lore lookup: hover a name (or press Ctrl+K Ctrl+I) for its card,
// F12 to open the lore file, Alt+F12 to peek at it in place.

import * as vscode from 'vscode';
import type { LoreEntry } from '../core/library';
import { headChars } from '../core/text';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

const HOVER_CHARS = 300;

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

interface Found {
	index: FolderIndex;
	entries: LoreEntry[];
	range: vscode.Range;
}

export class LoreProviders implements vscode.HoverProvider, vscode.DefinitionProvider {
	constructor(private readonly indexes: WorkspaceIndexes) {}

	private async find(document: vscode.TextDocument, position: vscode.Position): Promise<Found | undefined> {
		// Take the line now: the document can change while the index is loading.
		const line = document.lineAt(position.line).text;
		const located = await this.indexes.locate(document);
		if (!located) {
			return undefined;
		}
		const library = located.index.library;
		const match = library.matcher().at(line, position.character);
		if (!match) {
			return undefined;
		}
		const entries = match.ids.map((id) => library.entry(id)).filter((e): e is LoreEntry => e !== undefined);
		return {
			index: located.index,
			entries,
			range: new vscode.Range(position.line, match.start, position.line, match.end),
		};
	}

	async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		const found = await this.find(document, position);
		if (!found?.entries.length) {
			return undefined;
		}
		const cards = found.entries.map((entry) => {
			const card = new vscode.MarkdownString();
			card.appendMarkdown('**');
			card.appendText(entry.name);
			card.appendMarkdown('**');
			if (entry.type) {
				card.appendText(` · ${entry.type}`);
			}
			if (entry.always) {
				card.appendText(` · ${vscode.l10n.t('always on')}`);
			}
			if (entry.aliases.length) {
				card.appendMarkdown('\n\n');
				card.appendText(vscode.l10n.t('Also called: {0}', entry.aliases.join('、')));
			}
			const text = entry.summary ?? entry.body;
			if (text) {
				const cut = headChars(text, HOVER_CHARS);
				card.appendMarkdown('\n\n');
				card.appendMarkdown(cut.truncated ? `${cut.text}…` : cut.text);
			}
			card.appendMarkdown(`\n\n[${escapeMarkdown(vscode.l10n.t('Open {0}', entry.id))}](${found.index.uri(entry.id).toString()})`);
			return card;
		});
		return new vscode.Hover(cards, found.range);
	}

	async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.LocationLink[] | undefined> {
		const found = await this.find(document, position);
		if (!found?.entries.length) {
			return undefined;
		}
		const top = new vscode.Range(0, 0, 0, 0);
		return found.entries.map((entry) => ({
			originSelectionRange: found.range,
			targetUri: found.index.uri(entry.id),
			targetRange: top,
		}));
	}
}
