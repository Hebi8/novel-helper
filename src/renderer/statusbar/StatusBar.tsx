import { useSyncExternalStore } from 'react';
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

export function StatusBar({
	status,
	document,
	subscribeCursor,
	getCursor,
	subscribeDocs,
	getDocVersion,
	getWordsSnapshot,
	toggle,
}: {
	status: UsageStatus;
	document?: DocumentModel;
	subscribeCursor: (listener: () => void) => () => void;
	getCursor: () => CursorInfo;
	subscribeDocs: (listener: () => void) => () => void;
	getDocVersion: () => number;
	getWordsSnapshot: () => WordsSnapshot;
	toggle(): void;
}) {
	useDocument(document);
	const cursor = useSyncExternalStore(subscribeCursor, getCursor);
	useSyncExternalStore(subscribeDocs, getDocVersion);
	const workspace = useWorkspace();
	const activePath = workspace.session.active;
	const cursorMatchesActive = Boolean(activePath && cursor.path === activePath);
	const words = document ? (cursorMatchesActive ? cursor.totalWords : document.words) : 0;
	const activeIsChapter = Boolean(document && workspace.book && activePath && isChapterNode(workspace.book.tree, activePath));
	const conflicts = workspace.book?.conflicts ?? [];

	const snapshot = getWordsSnapshot();
	let todayNet = snapshot.todayWords;
	if (activeIsChapter && document && activePath && !document.readOnly) {
		const baseWords = snapshot.chapterWords[activePath] ?? document.baseWords;
		todayNet += words - baseWords;
	}

	let rightWordsText = `${words.toLocaleString()} ${zh.words}`;
	if (activeIsChapter && document && cursorMatchesActive) {
		if (cursor.anchor !== cursor.head) {
			rightWordsText = zh.selectedWordsLabel(cursor.selectedWords, words);
		} else if (cursor.focused) {
			rightWordsText = zh.cursorWordsLabel(cursor.beforeWords, words);
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
