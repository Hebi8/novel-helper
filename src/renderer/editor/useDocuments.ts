import { errorMessage } from '../errors';
import { useRef, useState } from 'react';
import type { DiskFile, SessionState } from '../../shared/api';
import type { EditorHandle } from './Editor';
import { DocumentModel } from './document';
export function useDocuments() {
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
			pending = window.novel.book
				.read(path)
				.then((file) => {
					const model = new DocumentModel(path, file.text, window.novel);

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
		void window.novel.window.saveSession(sessionRef.current);
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
		const old = sessionRef.current.active;
		if (old) {
			void documents.current.get(old)?.save();
		}
		persist({ ...sessionRef.current, active: path });
	};
	const open = async (path: string) => {
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
		persist({
			tabs: current.tabs.some((tab) => tab.path === path) ? current.tabs : [...current.tabs, { path, anchor: 0, head: 0 }],
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
		handles.current.forEach((handle) => handle.ghost.send({ type: 'blur' }));
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
		return model && tab ? { path: model.path, text: model.text, anchor: tab.anchor, head: tab.head } : undefined;
	};
	return {
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
