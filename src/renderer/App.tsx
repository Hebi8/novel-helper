import { Initialize } from './scaffold/Initialize';
import { Popover } from './scaffold/Popover';
import { StructureInput } from './scaffold/StructureInput';
import { TrashDialog } from './scaffold/TrashDialog';
import { Search } from './scaffold/Search';
import type { StructureAction, TrashPreview, TrashTarget } from '../shared/structure';
import { QuickOpen } from './reference/QuickOpen';
import { useReferences } from './reference/useReferences';
import { errorMessage } from './errors';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, Book, ConflictDiff, OpenResult } from '../shared/api';
import { defaults } from '../shared/defaults';
import { ConflictCopyOverlay } from './editor/ConflictCopyOverlay';
import { LeftSidebar } from './left/LeftSidebar';
import { RightSidebar } from './right/RightSidebar';
import { Tabs } from './tabs/Tabs';
import { StatusBar } from './statusbar/StatusBar';
import { Editor } from './editor/Editor';
import { ReportView } from './editor/ReportView';
import { reportKind, useDocuments } from './editor/useDocuments';
import { BlockingOverlay } from './shell/BlockingOverlay';
import { TopBar } from './shell/TopBar';
import { Welcome } from './shell/Welcome';
import { commands } from './shell/commands';
import { handleBookTabShortcut } from './shell/tabShortcuts';
import { applyTheme } from './theme';
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
	const [renameBookRequest, setRenameBookRequest] = useState(0);
	const [trashDialog, setTrashDialog] = useState<TrashPreview>();
	const trashPlanningRef = useRef(false);
	const [trashing, setTrashingState] = useState(false);
	const trashingRef = useRef(false);
	const setTrashing = (value: boolean) => {
		trashingRef.current = value;
		setTrashingState(value);
	};
	const [savingICloud, setSavingICloudState] = useState<'confirm' | 'running'>();
	const savingICloudRef = useRef<'confirm' | 'running' | undefined>(undefined);
	const setSavingICloud = (value: 'confirm' | 'running' | undefined) => {
		savingICloudRef.current = value;
		setSavingICloudState(value);
	};
	const [closing, setClosingState] = useState(false);
	const closingRef = useRef(false);
	const setClosing = (value: boolean) => {
		closingRef.current = value;
		setClosingState(value);
	};
	const isTransferLocked = () => savingICloudRef.current === 'running' || trashingRef.current;
	const isWindowLocked = () => isTransferLocked() || closingRef.current;
	const isRunningOverlay = savingICloud === 'running' || trashing || closing;
	const hasModal =
		isRunningOverlay ||
		Boolean(trashDialog) ||
		savingICloud === 'confirm' ||
		Boolean(structure) ||
		search ||
		quick ||
		Boolean(openResult?.kind === 'empty' && openResult.root);
	const modalOpenRef = useRef(false);
	modalOpenRef.current = hasModal || trashPlanningRef.current;
	const [conflictDiff, setConflictDiff] = useState<ConflictDiff>();
	const canSaveToICloud = Boolean(book && !book.inICloud && initial?.icloudAvailable);
	useEffect(() => {
		document.title = book ? book.name : zh.app;
	}, [book]);
	const requestRenameBook = () => {
		if (!book || modalOpenRef.current) {
			return;
		}
		if (focus) {
			void window.novel.window.focus(false).then(() => setFocus(false));
		}
		setLeft(0);
		setLeftOpen(true);
		setRenameBookRequest((count) => count + 1);
	};
	const requestTrash = (target: TrashTarget) => {
		if (!book || modalOpenRef.current) {
			return;
		}
		trashPlanningRef.current = true;
		modalOpenRef.current = true;
		void (async () => {
			try {
				await Promise.all([...docs.documents.current.values()].map((model) => model.save()));
				const preview = await window.novel.structure.trashPlan(target);
				if (isWindowLocked()) {
					return;
				}
				setError('');
				setTrashDialog(preview);
			} catch (err) {
				modalOpenRef.current = false;
				setError(errorMessage(err));
			} finally {
				trashPlanningRef.current = false;
			}
		})();
	};
	const confirmTrash = async () => {
		if (!trashDialog || isWindowLocked()) {
			return;
		}
		const plan = trashDialog;
		setStructure(undefined);
		setTrashDialog(undefined);
		setSavingICloud(undefined);
		setSearch(false);
		setQuick(false);
		(document.activeElement as HTMLElement | null)?.blur();
		setTrashing(true);
		try {
			if (!(await docs.saveAll())) {
				setTrashing(false);
				setError(zh.assistantSaveFailed);
				requestAnimationFrame(() => docs.focus());
				return;
			}
			const result = await window.novel.structure.trash(plan);
			for (const tab of [...docs.sessionRef.current.tabs]) {
				if (result.trashed.some((removed) => tab.path === removed || tab.path.startsWith(`${removed}/`))) {
					docs.closeRemoved(tab.path);
				}
			}
			if (
				conflictDiff &&
				result.trashed.some(
					(removed) =>
						conflictDiff.path === removed ||
						conflictDiff.path.startsWith(`${removed}/`) ||
						conflictDiff.original === removed ||
						conflictDiff.original.startsWith(`${removed}/`),
				)
			) {
				setConflictDiff(undefined);
			}
			setTrashing(false);
			setError(result.error ?? '');
			requestAnimationFrame(() => docs.focus());
		} catch (err) {
			setTrashing(false);
			setError(errorMessage(err));
			requestAnimationFrame(() => docs.focus());
		}
	};
	const requestSaveToICloud = () => {
		if (canSaveToICloud && !modalOpenRef.current) {
			modalOpenRef.current = true;
			setSavingICloud('confirm');
		}
	};
	const confirmSaveToICloud = async () => {
		if (!book || isWindowLocked()) {
			return;
		}
		setStructure(undefined);
		setTrashDialog(undefined);
		setSearch(false);
		setQuick(false);
		setConflictDiff(undefined);
		(document.activeElement as HTMLElement | null)?.blur();
		setSavingICloud('running');
		try {
			if (!(await docs.saveAll())) {
				setSavingICloud(undefined);
				setError(zh.assistantSaveFailed);
				requestAnimationFrame(() => docs.focus());
				return;
			}
			await window.novel.book.saveToICloud();
			window.novel.window.flushed();
		} catch (error) {
			setSavingICloud(undefined);
			setError(errorMessage(error));
			requestAnimationFrame(() => docs.focus());
		}
	};
	const openConflict = (path: string) => {
		void window.novel.book
			.conflictDiff(path)
			.then((diff) => {
				setError('');
				setConflictDiff(diff);
			})
			.catch((error) => setError(errorMessage(error)));
	};
	const refreshConflict = async (path: string) => {
		try {
			setConflictDiff(await window.novel.book.conflictDiff(path));
		} catch (error) {
			setConflictDiff(undefined);
			setError(errorMessage(error));
		}
	};
	const showStructure = (action: StructureAction, path?: string) => {
		if (book && !modalOpenRef.current) {
			modalOpenRef.current = true;
			setStructure({ action, path: path ?? docs.sessionRef.current.active });
		}
	};
	const openSearch = () => {
		if (book && !modalOpenRef.current) {
			modalOpenRef.current = true;
			setSearch(true);
		}
	};
	const openQuick = () => {
		if (book && !modalOpenRef.current) {
			modalOpenRef.current = true;
			setQuick(true);
		}
	};
	const toggleFocus = () => {
		if (!book || modalOpenRef.current) {
			return;
		}
		void window.novel.window
			.focus(!focus)
			.then(() => {
				setFocus(!focus);
				if (!isWindowLocked()) {
					docs.focus();
				}
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
	const { session, documents } = docs;
	const actions = commands({
		documents: docs,
		renameBook: requestRenameBook,
		saveToICloud: requestSaveToICloud,
		newChapter: () => showStructure('chapter'),
		searchBook: openSearch,
		focus: toggleFocus,
		quickOpen: openQuick,
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
	const bookRootRef = useRef<string | undefined>(undefined);
	bookRootRef.current = book?.root;
	useEffect(() => {
		if (initial) {
			applyTheme(initial.settings['appearance.theme']);
		}
	}, [initial?.settings['appearance.theme']]);
	useEffect(() => {
		let alive = true;
		let focusUpdated = false;
		let closingUpdated = false;
		void window.novel.window
			.bootstrap()
			.then(async (data) => {
				if (alive) {
					if (!focusUpdated) {
						setFocus(data.focus);
					}
					if (!closingUpdated) {
						setClosing(data.closing);
					}
				}
				await docs.restore(data.session);
				if (alive) {
					docs.setWordsSnapshot(data.words);
					setInitial(data);
					setBook(data.book);
					if (data.openResult) {
						setOpenResult(data.openResult);
					}
					if (data.notice) {
						setError(data.notice);
					}
				}
			})
			.catch((error) => setError(errorMessage(error)));
		const unsubscribes = [
			window.novel.book.onOpenResult(setOpenResult),
			window.novel.window.onFocusChanged((enabled) => {
				focusUpdated = true;
				setFocus(enabled);
			}),
			window.novel.window.onClosingChanged((value) => {
				closingUpdated = true;
				setClosing(value);
			}),
			window.novel.reports.onChanged(() => {
				void docs.refreshReports().catch((error) => setError(errorMessage(error)));
			}),
			window.novel.book.onChanged(setBook),
			window.novel.book.onFileChanged(docs.external),
			window.novel.book.onWordsChanged((update) => {
				if (update.root === bookRootRef.current) {
					docs.setWordsSnapshot({ todayWords: update.todayWords, chapterWords: update.chapterWords });
				}
			}),
			window.novel.settings.onChanged((settings) => setInitial((value) => (value ? { ...value, settings } : value))),
			window.novel.usage.onChanged((usage) => setInitial((value) => (value ? { ...value, usage } : value))),
			window.novel.window.onCommand((command) => {
				if (isTransferLocked()) {
					if (command === 'flush') {
						window.novel.window.flushed(false);
					}
					return;
				}
				if (closingRef.current) {
					if (command === 'flush' || command === 'blur') {
						actionRef.current[command]();
					}
					return;
				}
				if (command !== 'flush' && command !== 'blur' && modalOpenRef.current) {
					return;
				}
				actionRef.current[command]();
			}),
			window.novel.window.onNotice(setError),
		];
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isWindowLocked()) {
				handleBookTabShortcut(event);
			}
		};
		const onBlur = () => {
			if (!isWindowLocked()) {
				docs.blur();
			}
		};
		window.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('blur', onBlur);
		return () => {
			alive = false;
			unsubscribes.forEach((unsubscribe) => unsubscribe());
			window.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('blur', onBlur);
			docs.dispose();
		};
	}, []);
	const openBook = (root?: string, selected = false) => {
		if (isWindowLocked()) {
			return;
		}
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
				settings: initial?.settings ?? defaults,
				structure: showStructure,
				renameBook: requestRenameBook,
				trash: requestTrash,
				searchBook: openSearch,
				session,
				current: docs.current,
				reference,
				buoy: buoy?.chapter === chapter.current ? buoy : undefined,
				chapter: chapter.current,
				split: docs.toggleSplit,
				focusEditor: docs.focus,
				find: actions.find,
				quickOpen: openQuick,
				report: docs.openReport,
				showOutline: actions['right:0'],
				open: docs.open,
				openConflict,
				saveAll: docs.saveAll,
				fail: setError,
			}}
		>
			<div className={`app ${focus ? 'focus-mode' : ''}`}>
				{!isRunningOverlay && openResult?.kind === 'empty' && openResult.root ? (
					<Initialize root={openResult.root} close={() => setOpenResult(undefined)} opened={setOpenResult} />
				) : !isRunningOverlay && structure && book ? (
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
				) : !isRunningOverlay && trashDialog && book ? (
					<TrashDialog
						preview={trashDialog}
						close={() => {
							setTrashDialog(undefined);
							docs.focus();
						}}
						submit={() => {
							void confirmTrash();
						}}
					/>
				) : !isRunningOverlay && savingICloud === 'confirm' && book ? (
					<Popover
						title={zh.saveToICloud}
						close={() => {
							setSavingICloud(undefined);
							docs.focus();
						}}
						submit={() => {
							void confirmSaveToICloud();
						}}
					>
						<p>{zh.saveToICloudConfirm(book.root.split('/').pop() ?? book.name)}</p>
					</Popover>
				) : !isRunningOverlay && search && book ? (
					<Search close={() => setSearch(false)} />
				) : !isRunningOverlay && quick && book ? (
					<QuickOpen close={() => setQuick(false)} />
				) : null}
				<TopBar
					name={book?.name}
					canSaveToICloud={canSaveToICloud}
					savingToICloud={Boolean(savingICloud) || Boolean(trashDialog) || trashing}
					saveToICloud={requestSaveToICloud}
					left={actions['left:toggle']}
					right={actions['right:toggle']}
				/>
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
								renameBookRequest={renameBookRequest}
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
								{session.tabs.map((tab) => {
									const kind = reportKind(tab.path);
									const visible = focus
										? tab.path === session.active
										: docs.panes
											? tab.path === docs.panes.left || tab.path === docs.panes.right
											: tab.path === session.active;
									const side = docs.panes?.right === tab.path ? 'right' : 'left';
									const focused = () => {
										if (session.active !== tab.path) {
											docs.select(tab.path);
										}
									};
									return kind ? (
										<ReportView
											key={tab.path}
											kind={kind}
											document={documents.current.get(tab.path)!}
											active={tab.path === session.active}
											visible={visible}
											side={side}
											focused={focused}
										/>
									) : (
										<Editor
											key={tab.path}
											document={documents.current.get(tab.path)!}
											tab={tab}
											active={tab.path === session.active}
											visible={visible}
											side={side}
											focused={focused}
											chapter={book ? isChapter(book.tree, tab.path) : false}
											settings={initial.settings}
											limited={initial.usage.state === 'limit'}
											nextRequestId={docs.nextRequestId}
											ready={(handle) => docs.registerHandle(tab.path, handle)}
											cursor={(anchor, head, isFocused, counts) => docs.cursor(tab.path, anchor, head, isFocused, counts)}
										/>
									);
								})}
							</div>
						</main>
						{book ? <RightSidebar hidden={focus || !rightOpen} section={right} select={setRight} /> : null}
						{conflictDiff && book ? (
							<ConflictCopyOverlay
								diff={conflictDiff}
								close={() => {
									setConflictDiff(undefined);
									docs.focus();
								}}
								blockReason={docs.conflictBlockReason}
								onRefresh={refreshConflict}
								onResolved={docs.closeRemoved}
								onError={setError}
							/>
						) : null}
					</div>
				) : (
					<Welcome
						ready={Boolean(initial)}
						recent={initial?.recent ?? []}
						initialICloudBooks={initial?.icloudBooks ?? []}
						result={openResult}
						open={openBook}
						dismiss={() => setOpenResult(undefined)}
					/>
				)}
				{initial ? (
					<StatusBar
						status={initial.usage}
						document={active}
						subscribeCursor={docs.subscribeCursor}
						getCursor={docs.getCursor}
						subscribeDocs={docs.subscribeDocs}
						getDocVersion={docs.getDocVersion}
						getWordsSnapshot={docs.getWordsSnapshot}
						toggle={() => {
							if (initial.usage.missingKey) {
								void window.novel.settings.open();
							} else {
								void window.novel.settings.set('enabled', !initial.settings.enabled);
							}
						}}
					/>
				) : null}
				{savingICloud === 'running' ? (
					<BlockingOverlay text={zh.savingToICloud} />
				) : trashing ? (
					<BlockingOverlay text={zh.movingToTrash} />
				) : closing ? (
					<BlockingOverlay text={zh.closingWindow} />
				) : null}
			</div>
		</WorkspaceContext>
	);
}
function isChapter(node: Book['tree'], path: string): boolean {
	return (node.kind === 'chapter' && node.path === path) || node.children.some((child) => isChapter(child, path));
}
