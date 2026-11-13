import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, Book, OpenResult } from '../shared/api';
import { LeftSidebar } from './left/LeftSidebar';
import { RightSidebar } from './right/RightSidebar';
import { Tabs } from './tabs/Tabs';
import { StatusBar } from './statusbar/StatusBar';
import { Editor } from './editor/Editor';
import { useDocuments } from './editor/useDocuments';
import { ConflictBar } from './editor/ConflictBar';
import { TopBar } from './shell/TopBar';
import { Welcome } from './shell/Welcome';
import { commands } from './shell/commands';
import { zh } from './strings';
import { WorkspaceContext } from './workspace';
export function App() {
	const [initial, setInitial] = useState<Bootstrap>();
	const [book, setBook] = useState<Book>();
	const [left, setLeft] = useState(0);
	const [right, setRight] = useState(0);
	const [leftOpen, setLeftOpen] = useState(true);
	const [rightOpen, setRightOpen] = useState(true);
	const [openResult, setOpenResult] = useState<OpenResult>();
	const [error, setError] = useState('');
	const docs = useDocuments();
	const { session, documents, handles } = docs;
	const actions = commands({
		documents: docs,
		toggleLeft: () => setLeftOpen((value) => !value),
		toggleRight: () => setRightOpen((value) => !value),
		left: (section) => {
			setLeft(section);
			setLeftOpen(true);
		},
		right: (section) => {
			setRight(section);
			setRightOpen(true);
		},
	});
	const actionRef = useRef(actions);
	actionRef.current = actions;
	useEffect(() => {
		let alive = true;
		void window.novel.window
			.bootstrap()
			.then(async (data) => {
				await docs.restore(data.session);
				if (alive) {
					setInitial(data);
					setBook(data.book);
				}
			})
			.catch((error) => setError(String(error)));
		const unsubscribes = [
			window.novel.book.onOpenResult(setOpenResult),
			window.novel.book.onChanged(setBook),
			window.novel.book.onFileChanged(docs.external),
			window.novel.settings.onChanged((settings) => setInitial((value) => (value ? { ...value, settings } : value))),
			window.novel.usage.onChanged((usage) => setInitial((value) => (value ? { ...value, usage } : value))),
			window.novel.window.onCommand((command) => actionRef.current[command]()),
		];
		window.addEventListener('blur', docs.blur);
		return () => {
			alive = false;
			unsubscribes.forEach((unsubscribe) => unsubscribe());
			window.removeEventListener('blur', docs.blur);
			docs.dispose();
		};
	}, []);
	const openBook = (root?: string) => {
		void window.novel.book
			.open(root)
			.then(setOpenResult)
			.catch((error) => setError(String(error)));
	};
	const active = session.active ? documents.current.get(session.active) : undefined;

	return (
		<WorkspaceContext
			value={{
				book,
				session,
				current: docs.current,
				open: docs.open,
				saveAll: docs.saveAll,
			}}
		>
			<div className="app">
				<TopBar name={book?.name} left={actions['left:toggle']} right={actions['right:toggle']} />
				{openResult?.kind === 'error' && book ? (
					<div role="alert" className="notice">
						{openResult.message}
					</div>
				) : null}
				{error || docs.error ? (
					<div className="notice" role="alert">
						{error || docs.error}
					</div>
				) : null}
				{book && openResult?.kind === 'choices' ? (
					<div className="notice">
						{openResult.roots.map((root) => (
							<button key={root} onClick={() => openBook(root)}>
								{root}
							</button>
						))}
					</div>
				) : book && openResult?.kind === 'empty' ? (
					<div className="notice">{zh.empty}</div>
				) : null}
				{book && initial ? (
					<div className="workspace">
						<LeftSidebar
							hidden={!leftOpen}
							book={book}
							selected={session.active}
							section={left}
							select={setLeft}
							open={(path) => {
								void docs.open(path);
							}}
						/>
						<main className="writing">
							<Tabs
								tabs={session.tabs}
								active={session.active}
								select={docs.select}
								close={(path) => {
									void docs.close(path);
								}}
							/>
							<ConflictBar
								document={active}
								reload={() => {
									if (active) {
										handles.current.get(active.path)?.reload();
									}
								}}
							/>
							{session.tabs.map((tab) => (
								<Editor
									key={tab.path}
									document={documents.current.get(tab.path)!}
									tab={tab}
									active={tab.path === session.active}
									chapter={isChapter(book.tree, tab.path)}
									settings={initial.settings}
									limited={initial.usage.state === 'limit'}
									nextRequestId={docs.nextRequestId}
									ready={(handle) => {
										if (handle) {
											handles.current.set(tab.path, handle);
										} else {
											handles.current.delete(tab.path);
										}
									}}
									cursor={(anchor, head) => docs.cursor(tab.path, anchor, head)}
								/>
							))}
						</main>
						<RightSidebar hidden={!rightOpen} section={right} select={setRight} />
					</div>
				) : (
					<Welcome recent={initial?.recent ?? []} result={openResult} open={openBook} />
				)}
				{initial ? (
					<StatusBar
						status={initial.usage}
						document={active}
						toggle={() => {
							if (initial.usage.missingKey) {
								void window.novel.settings.open();
							} else {
								void window.novel.settings.set('enabled', !initial.settings.enabled);
							}
						}}
					/>
				) : null}
			</div>
		</WorkspaceContext>
	);
}
function isChapter(node: Book['tree'], path: string): boolean {
	return (node.kind === 'chapter' && node.path === path) || node.children.some((child) => isChapter(child, path));
}
