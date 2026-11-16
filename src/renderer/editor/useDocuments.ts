import { movedPath } from '../../shared/paths';
import type { Rename } from '../../core/library';
import { errorMessage } from '../errors';
import { zh } from '../strings';
import { useRef, useState } from 'react';
import type { DiskFile, SessionState, OpenOptions, ReportKind, WordsSnapshot } from '../../shared/api';
import type { EditorHandle } from './Editor';
import { DocumentModel } from './document';
import { wordCountsAt, type EditorWordCounts } from './prose';
export interface CursorInfo {
	path?: string;
	anchor: number;
	head: number;
	focused: boolean;
	totalWords: number;
	beforeWords: number;
	selectedWords: number;
}
export const reportPaths: Record<ReportKind, string> = { report: 'report:last-request', usageReport: 'report:usage' };
export const reportKind = (path: string) => (Object.keys(reportPaths) as ReportKind[]).find((key) => reportPaths[key] === path);
export function useDocuments() {
	const [panes, setPanes] = useState<{ left?: string; right?: string }>();
	const panesRef = useRef(panes);
	const setSplit = (value: typeof panes) => {
		panesRef.current = value;
		setPanes(value);
	};
	const [session, setSession] = useState<SessionState>({ tabs: [] });
	const sessionRef = useRef(session);

	const [error, setError] = useState('');
	const sessionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const documents = useRef(new Map<string, DocumentModel>());
	const handles = useRef(new Map<string, EditorHandle>());
	const pendingOffsets = useRef(new Map<string, number>());
	const opening = useRef(new Map<string, Promise<DocumentModel>>());
	const serial = useRef(0);
	const nextRequestId = () => ++serial.current;
	const cursorRef = useRef<CursorInfo>({ anchor: 0, head: 0, focused: false, totalWords: 0, beforeWords: 0, selectedWords: 0 });
	const cursorListeners = useRef(new Set<() => void>());
	const docVersionRef = useRef(0);
	const docListeners = useRef(new Set<() => void>());
	const wordsSnapshotRef = useRef<WordsSnapshot>({ todayWords: 0, chapterWords: {} });
	const notifyDocs = () => {
		docVersionRef.current++;
		docListeners.current.forEach((listener) => listener());
	};
	const notifyCursor = (next: CursorInfo) => {
		const prev = cursorRef.current;
		if (
			prev.path === next.path &&
			prev.anchor === next.anchor &&
			prev.head === next.head &&
			prev.focused === next.focused &&
			prev.totalWords === next.totalWords &&
			prev.beforeWords === next.beforeWords &&
			prev.selectedWords === next.selectedWords
		) {
			return;
		}
		cursorRef.current = next;
		cursorListeners.current.forEach((listener) => listener());
	};
	const setWordsSnapshot = (words: WordsSnapshot) => {
		wordsSnapshotRef.current = words;
		notifyDocs();
	};
	const load = (path: string) => {
		const existing = documents.current.get(path);
		if (existing) {
			return Promise.resolve(existing);
		}
		let pending = opening.current.get(path);
		if (!pending) {
			const kind = reportKind(path);
			pending = (kind ? window.novel.reports.get(kind).then((text) => ({ path, text })) : window.novel.book.read(path))
				.then((file) => {
					const model = new DocumentModel(path, file.text, window.novel, kind !== undefined);
					model.onChanged = notifyDocs;

					documents.current.set(path, model);

					return model;
				})
				.finally(() => opening.current.delete(path));
			opening.current.set(path, pending);
		}
		return pending;
	};
	const flushSession = () => {
		clearTimeout(sessionTimer.current);
		const current = sessionRef.current;
		void window.novel.window.saveSession({
			tabs: current.tabs.filter((tab) => !reportKind(tab.path)),
			active: current.active && !reportKind(current.active) ? current.active : undefined,
		});
	};
	const scheduleSession = () => {
		clearTimeout(sessionTimer.current);
		sessionTimer.current = setTimeout(flushSession, 500);
	};
	const persist = (value: SessionState) => {
		sessionRef.current = value;
		setSession(value);
		scheduleSession();
	};
	const select = (path: string) => {
		const split = panesRef.current;
		if (split && split.left !== path && split.right !== path) {
			setSplit(sessionRef.current.active === split.right ? { ...split, right: path } : { ...split, left: path });
		}
		const old = sessionRef.current.active;
		if (old) {
			void documents.current.get(old)?.save();
		}
		persist({ ...sessionRef.current, active: path });
	};
	const open = async (path: string, options: OpenOptions = {}) => {
		try {
			await load(path);
		} catch (error) {
			setError(errorMessage(error));
			return;
		}
		setError('');
		const current = sessionRef.current;
		if (current.active) {
			await documents.current.get(current.active)?.save();
		}
		if (options.beside && current.active && current.active !== path) {
			setSplit({ left: current.active, right: path });
		} else if (panesRef.current && panesRef.current.left !== path && panesRef.current.right !== path) {
			setSplit(current.active === panesRef.current.right ? { ...panesRef.current, right: path } : { ...panesRef.current, left: path });
		}
		const offset =
			options.offset !== undefined
				? options.offset
				: options.line === undefined
					? undefined
					: documents.current
							.get(path)!
							.text.split('\n')
							.slice(0, options.line)
							.reduce((sum, line) => sum + line.length + 1, 0);
		if (offset !== undefined) {
			const handle = handles.current.get(path);
			if (handle) {
				handle.goTo(offset);
			} else {
				pendingOffsets.current.set(path, offset);
			}
		}
		persist({
			tabs: current.tabs.some((tab) => tab.path === path)
				? current.tabs.map((tab) => (tab.path === path && offset !== undefined ? { ...tab, anchor: offset, head: offset } : tab))
				: [...current.tabs, { path, anchor: offset ?? 0, head: offset ?? 0 }],
			active: path,
		});
	};
	const close = async (path: string) => {
		const model = documents.current.get(path)!;
		await model.save();
		if (model.blocksClose) {
			select(path);
			return;
		}
		const current = sessionRef.current;
		const index = current.tabs.findIndex((tab) => tab.path === path);
		const tabs = current.tabs.filter((tab) => tab.path !== path);
		persist({ tabs, active: current.active === path ? tabs[Math.min(index, tabs.length - 1)]?.path : current.active });
		if (panesRef.current?.left === path || panesRef.current?.right === path) {
			setSplit(undefined);
		}
		pendingOffsets.current.delete(path);
		documents.current.delete(path);
		model.dispose();
	};
	const closeRemoved = (path: string) => {
		const model = documents.current.get(path);
		if (!model) {
			return;
		}
		const current = sessionRef.current;
		const index = current.tabs.findIndex((tab) => tab.path === path);
		const tabs = current.tabs.filter((tab) => tab.path !== path);
		persist({ tabs, active: current.active === path ? tabs[Math.min(index, tabs.length - 1)]?.path : current.active });
		if (panesRef.current?.left === path || panesRef.current?.right === path) {
			setSplit(undefined);
		}
		pendingOffsets.current.delete(path);
		documents.current.delete(path);
		model.dispose();
	};
	const conflictBlockReason = (paths: readonly string[]): string | undefined => {
		for (const path of paths) {
			const model = documents.current.get(path);
			if (!model) {
				continue;
			}
			if (model.conflict !== undefined) {
				select(path);
				return zh.conflictBlockedConflict;
			}
			if (model.dirty) {
				select(path);
				return zh.conflictBlockedUnsaved;
			}
		}
		return undefined;
	};
	const saveAll = async () => {
		flushSession();
		await Promise.all([...documents.current.values()].map((model) => model.save()));
		const blocked = [...documents.current.values()].find((model) => model.blocksClose);
		if (blocked) {
			select(blocked.path);
		}
		return !blocked;
	};
	const restore = async (value: SessionState) => {
		const loaded = await Promise.all(
			value.tabs.map(async (tab) => {
				try {
					await load(tab.path);
					return tab;
				} catch (error) {
					setError(errorMessage(error));
					return undefined;
				}
			}),
		);
		const tabs = loaded.filter((tab): tab is SessionState['tabs'][number] => tab !== undefined);
		const restored = { tabs, active: tabs.some((tab) => tab.path === value.active) ? value.active : tabs[0]?.path };
		sessionRef.current = restored;
		setSession(restored);
	};
	const external = (file: DiskFile) => {
		const model = documents.current.get(file.path);
		if (model?.external(file) === 'reload') {
			handles.current.get(file.path)?.reload();
		}
	};
	const cursor = (path: string, anchor: number, head: number, focused?: boolean, counts?: EditorWordCounts) => {
		const current = sessionRef.current;
		sessionRef.current = { ...current, tabs: current.tabs.map((tab) => (tab.path === path ? { ...tab, anchor, head } : tab)) };
		if (current.active === path) {
			const view = handles.current.get(path)?.view;
			const viewFocused = focused ?? (view ? view.root.activeElement === view.contentDOM : false);
			const resolved = counts ?? (view ? wordCountsAt(view.state) : { total: 0, beforeHead: 0, selected: 0 });
			notifyCursor({
				path,
				anchor,
				head,
				focused: viewFocused,
				totalWords: resolved.total,
				beforeWords: resolved.beforeHead,
				selectedWords: resolved.selected,
			});
		}
		scheduleSession();
	};
	const moveTab = (step: number) => {
		const current = sessionRef.current;
		const index = current.tabs.findIndex((tab) => tab.path === current.active);
		if (current.tabs.length) {
			select(current.tabs[(index + step + current.tabs.length) % current.tabs.length].path);
		}
	};
	const blur = () => {
		flushSession();
		handles.current.forEach((handle) => {
			handle.ghost.send({ type: 'blur' });
		});
		documents.current.forEach((model) => {
			void model.save();
		});
	};

	const dispose = () => {
		clearTimeout(sessionTimer.current);
		documents.current.forEach((model) => model.dispose());
	};
	const current = () => {
		const tab = sessionRef.current.tabs.find((tab) => tab.path === sessionRef.current.active);
		const model = tab ? documents.current.get(tab.path) : undefined;
		return model && !model.readOnly && tab ? { path: model.path, text: model.text, anchor: tab.anchor, head: tab.head } : undefined;
	};
	const toggleSplit = () => {
		if (panesRef.current) {
			setSplit(undefined);
		} else if (sessionRef.current.active && sessionRef.current.tabs.length > 1) {
			setSplit({
				left: sessionRef.current.tabs.find((tab) => tab.path !== sessionRef.current.active)?.path,
				right: sessionRef.current.active,
			});
		}
	};
	const openReport = async (kind: ReportKind) => {
		const path = reportPaths[kind];
		if (documents.current.has(path)) {
			const text = await window.novel.reports.get(kind);
			external({ path, text });
		}
		await open(path);
	};
	const refreshReports = async () => {
		for (const kind of Object.keys(reportPaths) as ReportKind[]) {
			const path = reportPaths[kind];
			if (documents.current.has(path)) {
				external({ path, text: await window.novel.reports.get(kind) });
			}
		}
	};
	const remap = (renames: Rename[]) => {
		const move = (path: string) => movedPath(path, renames);
		const current = sessionRef.current;
		const mapped = new Map<string, DocumentModel>();
		for (const [path, model] of documents.current) {
			model.path = move(path);
			mapped.set(model.path, model);
		}
		documents.current = mapped;
		const mappedOffsets = new Map<string, number>();
		for (const [path, offset] of pendingOffsets.current) {
			mappedOffsets.set(move(path), offset);
		}
		pendingOffsets.current = mappedOffsets;
		if (panesRef.current) {
			setSplit({
				left: panesRef.current.left && move(panesRef.current.left),
				right: panesRef.current.right && move(panesRef.current.right),
			});
		}
		if (cursorRef.current.path) {
			cursorRef.current = { ...cursorRef.current, path: move(cursorRef.current.path) };
		}
		persist({ tabs: current.tabs.map((tab) => ({ ...tab, path: move(tab.path) })), active: current.active && move(current.active) });
	};
	const registerHandle = (path: string, handle?: EditorHandle) => {
		if (handle) {
			handles.current.set(path, handle);
			const offset = pendingOffsets.current.get(path);
			if (offset !== undefined) {
				pendingOffsets.current.delete(path);
				handle.goTo(offset);
			}
		} else {
			handles.current.delete(path);
		}
	};
	return {
		remap,
		registerHandle,
		focus: () => {
			const path = sessionRef.current.active;
			if (path) {
				handles.current.get(path)?.view.focus();
			}
		},
		panes,
		toggleSplit,
		openReport,
		refreshReports,
		session,
		sessionRef,
		documents,
		handles,
		nextRequestId,
		select,
		open,
		close,
		closeRemoved,
		conflictBlockReason,
		saveAll,
		restore,
		external,
		cursor,
		subscribeCursor: (listener: () => void) => {
			cursorListeners.current.add(listener);
			return () => {
				cursorListeners.current.delete(listener);
			};
		},
		getCursor: () => cursorRef.current,
		subscribeDocs: (listener: () => void) => {
			docListeners.current.add(listener);
			return () => {
				docListeners.current.delete(listener);
			};
		},
		getDocVersion: () => docVersionRef.current,
		getWordsSnapshot: () => wordsSnapshotRef.current,
		setWordsSnapshot,
		moveTab,
		blur,
		current,
		error,
		clearError: () => setError(''),
		dispose,
	};
}
