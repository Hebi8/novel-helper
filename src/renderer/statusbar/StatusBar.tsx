import { useSyncExternalStore } from 'react';
import { countWords } from '../../core/text';
import type { BookNode } from '../../core/library';
import { dollars } from '../../core/usage';
import type { UsageStatus, WordsSnapshot } from '../../shared/api';
import type { DocumentModel } from '../editor/document';
import type { CursorInfo } from '../editor/useDocuments';
import { useDocument } from '../editor/useDocument';
import { describeBuoy, zh } from '../strings';
import { useWorkspace } from '../workspace';

function isChapterNode(node: BookNode, path: string): boolean {
	return (node.kind === 'chapter' && node.path === path) || node.children.some((child) => isChapterNode(child, path));
}

function collectChapterPaths(node: BookNode, into = new Set<string>()): Set<string> {
	if (node.kind === 'chapter') {
		into.add(node.path);
	} else {
		node.children.forEach((child) => collectChapterPaths(child, into));
	}
	return into;
}

export function StatusBar({
	status,
	document,
	subscribeCursor,
	getCursor,
	subscribeDocs,
	getDocVersion,
	getWordsSnapshot,
	openDocuments,
	toggle,
}: {
	status: UsageStatus;
	document?: DocumentModel;
	subscribeCursor: (listener: () => void) => () => void;
	getCursor: () => CursorInfo;
	subscribeDocs: (listener: () => void) => () => void;
	getDocVersion: () => number;
	getWordsSnapshot: () => WordsSnapshot;
	openDocuments: () => ReadonlyMap<string, DocumentModel>;
	toggle(): void;
}) {
	useDocument(document);
	const cursor = useSyncExternalStore(subscribeCursor, getCursor);
	useSyncExternalStore(subscribeDocs, getDocVersion);
	const workspace = useWorkspace();
	const words = document ? countWords(document.text) : 0;
	const activePath = workspace.session.active;
	const activeIsChapter = Boolean(document && workspace.book && activePath && isChapterNode(workspace.book.tree, activePath));
	const conflicts = workspace.book?.conflicts ?? [];

	const snapshot = getWordsSnapshot();
	let todayNet = snapshot.todayWords;
	if (workspace.book) {
		const chapterPaths = collectChapterPaths(workspace.book.tree);
		for (const [path, model] of openDocuments()) {
			if (!model.readOnly && chapterPaths.has(path)) {
				const baseWords = snapshot.chapterWords[path] ?? countWords(model.base);
				todayNet += countWords(model.text) - baseWords;
			}
		}
	}

	let rightWordsText = `${words.toLocaleString()} ${zh.words}`;
	if (activeIsChapter && document && cursor.path === activePath) {
		if (cursor.anchor !== cursor.head) {
			const from = Math.min(cursor.anchor, cursor.head);
			const to = Math.max(cursor.anchor, cursor.head);
			rightWordsText = zh.selectedWordsLabel(countWords(document.text.slice(from, to)), words);
		} else if (cursor.focused) {
			const head = Math.max(0, Math.min(cursor.head, document.text.length));
			rightWordsText = zh.cursorWordsLabel(countWords(document.text.slice(0, head)), words);
		}
	}

	return (
		<footer className="statusbar">
			<button onClick={toggle} title={status.missingKey ? zh.missingKey : status.problem}>
				<span className={`status-dot ${status.state}`} />
				{zh.continuation} · {zh[status.state]}
			</button>
			{workspace.book ? (
				<span className="status-daily-words">{zh.todayWordsLabel(todayNet, workspace.settings['editor.dailyWordGoal'])}</span>
			) : null}
			<button
				onClick={() => {
					void workspace.report('usageReport');
				}}
			>
				{zh.today} {status.today.requests} {zh.requests} {status.priced ? ` · ${dollars(status.today.cost)}` : ''}
			</button>
			{workspace.chapter ? (
				<button className="status-buoy" onClick={workspace.showOutline}>
					{describeBuoy(workspace.buoy?.state, workspace.buoy?.lost, workspace.buoy?.unreadable)}
				</button>
			) : null}
			{conflicts.length ? (
				<button className="status-conflict" onClick={() => workspace.openConflict(conflicts[0].path)}>
					{zh.conflictCount(conflicts.length)}
				</button>
			) : null}
			<span className="grow" />
			<span className="status-chapter-words">{rightWordsText}</span>
		</footer>
	);
}
