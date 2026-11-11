// What the sidebar's commands share: picking the folder to work in, making a
// file and opening it, telling the writer why a name will not do.

import * as vscode from 'vscode';
import type { NameProblem } from '../core/book';
import type { FolderIndex, WorkspaceIndexes } from './workspaceIndex';

/** The only open folder, or the one the writer is in or picks; tells them to open one if there is none. */
export async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Open a folder first: Novel Helper works on the files of a folder.'));
		return undefined;
	}
	const editor = vscode.window.activeTextEditor;
	return folders.length === 1
		? folders[0]
		: ((editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? (await vscode.window.showWorkspaceFolderPick()));
}

/** The index of that folder, to make files in. Not when its story folder setting is no place to write to. */
export async function pickIndex(indexes: WorkspaceIndexes): Promise<FolderIndex | undefined> {
	const folder = await pickFolder();
	const index = folder && (await indexes.get(folder));
	if (index?.state === 'invalid') {
		void vscode.window.showErrorMessage(
			vscode.l10n.t('The story folder setting "{0}" is not a path inside the workspace folder. Run "Novel Helper: Select Story Folder" first.', index.storySetting),
		);
		return undefined;
	}
	return index;
}

export function joinPath(...parts: string[]): string {
	return parts.filter(Boolean).join('/');
}

/** Opens the file, making it with `content` first if it is not there. Undo takes the new file away again. */
export async function createAndOpen(uri: vscode.Uri, content = ''): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(content) });
	await vscode.workspace.applyEdit(edit);
	await vscode.window.showTextDocument(uri, { preview: false });
}

export function problemText(problem: NameProblem | undefined): string | undefined {
	switch (problem) {
		case 'empty':
			return vscode.l10n.t('Type a name.');
		case 'separator':
			return vscode.l10n.t('A name cannot contain / or \\.');
		case 'taken':
			return vscode.l10n.t('That name is taken.');
		default:
			return undefined;
	}
}
