import { useRef, useState } from 'react';
import type { DiskFile, SessionState } from '../../shared/api';
import type { EditorHandle } from './Editor';
import { DocumentModel } from './document';
export function useDocuments() {
	const [session, setSession] = useState<SessionState>({ tabs: [] });
	const sessionRef = useRef(session);
	sessionRef.current = session;
	const [, redraw] = useState(0);
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
			pending = window.novel.book.read(path).then((file) => {
				const model = new DocumentModel(path, file.text, window.novel);
				model.onChanged = () => redraw((n) => n + 1);
				documents.current.set(path, model);
				opening.current.delete(path);
				return model;
			});
			opening.current.set(path, pending);
		}
		return pending;
	};
	const persist = (value: SessionState) => {
		sessionRef.current = value;
		setSession(value);
		void window.novel.window.saveSession(value);
	};
	const select = (path: string) => {
		const old = sessionRef.current.active;
		if (old) {
			void documents.current.get(old)?.save();
		}
		persist({ ...sessionRef.current, active: path });
	};
	const open = async (path: string) => {
		await load(path);
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
		if (model.dirty || model.conflict !== undefined || model.error) {
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
		await Promise.all([...documents.current.values()].map((model) => model.save()));
		const blocked = [...documents.current.values()].find((model) => model.dirty || model.conflict !== undefined || model.error);
		if (blocked) {
			select(blocked.path);
		}
		return !blocked;
	};
	const restore = async (value: SessionState) => {
		await Promise.all(value.tabs.map((tab) => load(tab.path)));
		sessionRef.current = value;
		setSession(value);
	};
	const external = (file: DiskFile) => {
		const model = documents.current.get(file.path);
		if (model?.external(file) === 'reload') {
			handles.current.get(file.path)?.reload();
		}
	};
	const cursor = (path: string, anchor: number, head: number) => {
		const current = sessionRef.current;
		persist({ ...current, tabs: current.tabs.map((tab) => (tab.path === path ? { ...tab, anchor, head } : tab)) });
	};
	const moveTab = (step: number) => {
		const current = sessionRef.current;
		const index = current.tabs.findIndex((tab) => tab.path === current.active);
		if (current.tabs.length) {
			select(current.tabs[(index + step + current.tabs.length) % current.tabs.length].path);
		}
	};
	const blur = () => {
		handles.current.forEach((handle) => handle.ghost.send({ type: 'blur' }));
		documents.current.forEach((model) => {
			void model.save();
		});
	};
	const focus = () => {
		const active = sessionRef.current.active;
		if (active) {
			handles.current.get(active)?.ghost.send({ type: 'focus' });
		}
	};
	const dispose = () => documents.current.forEach((model) => model.dispose());
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
		focus,
		dispose,
	};
}
