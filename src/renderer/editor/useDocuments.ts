import { movedPath } from '../../shared/paths';
import type { Rename } from '../../core/library';
import { errorMessage } from '../errors';
import { useRef, useState } from 'react';
import type { DiskFile, SessionState, OpenOptions, ReportKind } from '../../shared/api';
import type { EditorHandle } from './Editor';
import { DocumentModel } from './document';
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
	const opening = useRef(new Map<string, Promise<DocumentModel>>());
	const serial = useRef(0);
	const nextRequestId = () => ++serial.current;
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
			handles.current.get(path)?.goTo(offset);
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
		documents.current.delete(path);
		model.dispose();
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
	const cursor = (path: string, anchor: number, head: number) => {
		const current = sessionRef.current;
		sessionRef.current = { ...current, tabs: current.tabs.map((tab) => (tab.path === path ? { ...tab, anchor, head } : tab)) };
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
		if (panesRef.current) {
			setSplit({
				left: panesRef.current.left && move(panesRef.current.left),
				right: panesRef.current.right && move(panesRef.current.right),
			});
		}
		persist({ tabs: current.tabs.map((tab) => ({ ...tab, path: move(tab.path) })), active: current.active && move(current.active) });
	};
	return {
		remap,
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
		saveAll,
		restore,
		external,
		cursor,
		moveTab,
		blur,
		current,
		error,
		clearError: () => setError(''),
		dispose,
	};
}
