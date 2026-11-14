import { Initialize } from './scaffold/Initialize';
import { StructureInput } from './scaffold/StructureInput';
import { Search } from './scaffold/Search';
import type { StructureAction } from '../shared/structure';
import { QuickOpen } from './reference/QuickOpen';
import { useReferences } from './reference/useReferences';
import { errorMessage } from './errors';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, Book, OpenResult } from '../shared/api';
import { LeftSidebar } from './left/LeftSidebar';
import { RightSidebar } from './right/RightSidebar';
import { Tabs } from './tabs/Tabs';
import { StatusBar } from './statusbar/StatusBar';
import { Editor } from './editor/Editor';
import { useDocuments } from './editor/useDocuments';
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
	const [quick, setQuick] = useState(false);
	const [search, setSearch] = useState(false);
	const [focus, setFocus] = useState(false);
	const [structure, setStructure] = useState<{ action: StructureAction; path?: string }>();
	const showStructure = (action: StructureAction, path?: string) => {
		if (book) {
			setStructure({ action, path: path ?? docs.sessionRef.current.active });
		}
	};
	const toggleFocus = () => {
		if (!book) {
			return;
		}
		void window.novel.window
			.focus(!focus)
			.then(() => {
				setFocus(!focus);
				docs.focus();
			})
			.catch((error) => setError(errorMessage(error)));
	};
	const chapter = useRef<string | undefined>(undefined);
	if (book && docs.session.active && isChapter(book.tree, docs.session.active)) {
		chapter.current = docs.session.active;
	}
	if (book && chapter.current && !isChapter(book.tree, chapter.current)) {
		chapter.current = undefined;
	}
	const { reference, buoy } = useReferences(
		book,
		chapter.current,
		() => (chapter.current ? docs.documents.current.get(chapter.current)?.text : undefined),
		setError,
	);
	const { session, documents, handles } = docs;
	const actions = commands({
		documents: docs,
		newChapter: () => showStructure('chapter'),
		searchBook: () => {
			if (book) {
				setSearch(true);
			}
		},
		focus: toggleFocus,
		quickOpen: () => setQuick(true),
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
					if (data.openResult) {
						setOpenResult(data.openResult);
					}
				}
			})
			.catch((error) => setError(errorMessage(error)));
		const unsubscribes = [
			window.novel.book.onOpenResult(setOpenResult),
			window.novel.window.onFocusChanged(setFocus),
			window.novel.reports.onChanged(() => {
				void docs.refreshReports().catch((error) => setError(errorMessage(error)));
			}),
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
	const openBook = (root?: string, selected = false) => {
		void window.novel.book
			.open(root, selected)
			.then(setOpenResult)
			.catch((error) => setError(errorMessage(error)));
	};
	const active = session.active ? documents.current.get(session.active) : undefined;

	return (
		<WorkspaceContext
			value={{
				book,
				structure: showStructure,
				searchBook: () => setSearch(true),
				session,
				current: docs.current,
				reference,
				buoy: buoy?.chapter === chapter.current ? buoy : undefined,
				chapter: chapter.current,
				split: docs.toggleSplit,
				focusEditor: docs.focus,
				find: actions.find,
				quickOpen: () => setQuick(true),
				report: docs.openReport,
				showOutline: actions['right:0'],
				open: docs.open,
				saveAll: docs.saveAll,
				fail: setError,
			}}
		>
			<div className={`app ${focus ? 'focus-mode' : ''}`}>
				{openResult?.kind === 'empty' && openResult.root ? (
					<Initialize root={openResult.root} close={() => setOpenResult(undefined)} opened={setOpenResult} />
				) : null}
				{structure && book ? (
					<StructureInput
						{...structure}
						close={() => {
							setStructure(undefined);
							docs.focus();
						}}
						submit={async (input) => {
							if (!(await docs.saveAll())) {
								throw new Error(zh.assistantSaveFailed);
							}
							const result = await window.novel.structure.create(input);
							if (result.renames) {
								docs.remap(result.renames);
							}
							if (result.error) {
								setError(result.error);
							}
							if (result.path) {
								await docs.open(result.path);
							}
							return true;
						}}
					/>
				) : null}
				{search && book ? <Search close={() => setSearch(false)} /> : null}
				{quick && book ? <QuickOpen close={() => setQuick(false)} /> : null}
				<TopBar name={book?.name} left={actions['left:toggle']} right={actions['right:toggle']} />
				{openResult?.kind === 'error' && book ? (
					<div role="alert" className="notice">
						{errorMessage(openResult.message)}
						<button onClick={() => setOpenResult(undefined)}>{zh.dismiss}</button>
					</div>
				) : null}
				{error || docs.error ? (
					<div className="notice" role="alert">
						{error || docs.error}
						<button
							onClick={() => {
								setError('');
								docs.clearError();
							}}
						>
							{zh.dismiss}
						</button>
					</div>
				) : null}
				{book && openResult?.kind === 'choices' ? (
					<div className="notice">
						{openResult.roots.map((root) => (
							<button key={root} onClick={() => openBook(root, true)}>
								{root}
							</button>
						))}
					</div>
				) : book && openResult?.kind === 'empty' ? (
					<div className="notice">{zh.empty}</div>
				) : null}
				{initial && (book || session.tabs.length) ? (
					<div className="workspace">
						{book ? (
							<LeftSidebar
								hidden={focus || !leftOpen}
								book={book}
								selected={session.active}
								section={left}
								select={setLeft}
								open={(path) => {
									void docs.open(path);
								}}
							/>
						) : null}
						<main className="writing">
							<Tabs
								tabs={session.tabs}
								active={session.active}
								select={docs.select}
								close={(path) => {
									void docs.close(path);
								}}
							/>

							<div className={`editor-panes ${docs.panes && !focus ? 'split' : ''}`}>
								{session.tabs.map((tab) => (
									<Editor
										key={tab.path}
										document={documents.current.get(tab.path)!}
										tab={tab}
										active={tab.path === session.active}
										visible={
											focus
												? tab.path === session.active
												: docs.panes
													? tab.path === docs.panes.left || tab.path === docs.panes.right
													: tab.path === session.active
										}
										side={docs.panes?.right === tab.path ? 'right' : 'left'}
										focused={() => {
											if (session.active !== tab.path) {
												docs.select(tab.path);
											}
										}}
										chapter={book ? isChapter(book.tree, tab.path) : false}
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
							</div>
						</main>
						{book ? <RightSidebar hidden={focus || !rightOpen} section={right} select={setRight} /> : null}
					</div>
				) : (
					<Welcome recent={initial?.recent ?? []} result={openResult} open={openBook} dismiss={() => setOpenResult(undefined)} />
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
