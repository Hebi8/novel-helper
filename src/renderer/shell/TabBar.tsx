import { useEffect, useState } from 'react';
import type { PlusMenuData, TabBarState } from '../../shared/api';
import { zh } from '../strings';
import { applyTheme } from '../theme';
import { BlockingOverlay } from './BlockingOverlay';
import { handleBookTabShortcut } from './tabShortcuts';

const MENU_WIDTH = 220;

export function TabBar() {
	const [state, setState] = useState<TabBarState>({ tabs: [], locked: false, theme: 'system' });
	const [menu, setMenu] = useState<{ x: number; y: number; data: PlusMenuData }>();

	const closeMenu = () => {
		setMenu(undefined);
		void window.novel.tabs.closeMenu();
	};

	const pickBook = (root?: string) => {
		setMenu(undefined);
		void window.novel.tabs.openBook(root);
	};

	useEffect(() => {
		applyTheme(state.theme);
	}, [state.theme]);

	useEffect(() => {
		if (state.locked && menu) {
			setMenu(undefined);
			void window.novel.tabs.closeMenu();
		}
	}, [state.locked, menu]);

	useEffect(() => {
		void window.novel.tabs.state().then((initial) => {
			setState(initial);
			applyTheme(initial.theme);
		});
		const offTabs = window.novel.tabs.onChanged(setState);
		const offSettings = window.novel.settings.onChanged((settings) => {
			setState((prev) => ({ ...prev, theme: settings['appearance.theme'] }));
		});
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.isComposing) {
				setMenu((current) => {
					if (current) {
						void window.novel.tabs.closeMenu();
					}
					return undefined;
				});
				return;
			}
			handleBookTabShortcut(event);
		};
		const onBlur = () => {
			setMenu((current) => {
				if (current) {
					void window.novel.tabs.closeMenu();
				}
				return undefined;
			});
		};
		window.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('blur', onBlur);
		return () => {
			offTabs();
			offSettings();
			window.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('blur', onBlur);
		};
	}, []);

	return (
		<>
			<header className="book-tabbar">
				<div className="book-tabbar-list" role="tablist" aria-label={zh.bookTabs}>
					{state.tabs.map((tab) => (
						<div
							key={tab.id}
							role="tab"
							tabIndex={0}
							aria-selected={tab.active}
							data-kind={tab.kind}
							className={`book-tab ${tab.active ? 'active' : ''}`}
							onClick={() => {
								if (!state.locked) {
									if (menu) {
										closeMenu();
									}
									void window.novel.tabs.select(tab.id);
								}
							}}
							onKeyDown={(event) => {
								if ((event.key === 'Enter' || event.key === ' ') && !state.locked) {
									event.preventDefault();
									void window.novel.tabs.select(tab.id);
								}
							}}
						>
							<span className="book-tab-title">{tab.title}</span>
							{tab.kind === 'book' ? (
								<button
									type="button"
									className="book-tab-close"
									disabled={state.locked}
									aria-label={`${zh.closeBookTab} ${tab.title}`}
									onClick={(event) => {
										event.stopPropagation();
										if (menu) {
											closeMenu();
										}
										void window.novel.tabs.close(tab.id);
									}}
								>
									✕
								</button>
							) : null}
						</div>
					))}
				</div>
				<button
					type="button"
					className="book-tabbar-plus"
					disabled={state.locked}
					aria-haspopup="menu"
					aria-expanded={Boolean(menu)}
					onClick={(event) => {
						if (menu) {
							closeMenu();
							return;
						}
						const rect = event.currentTarget.getBoundingClientRect();
						const x = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
						void window.novel.tabs.openMenu().then((data) => {
							setMenu({ x, y: 40, data });
						});
					}}
				>
					＋
				</button>
				<span className="grow" />
			</header>
			{menu && !state.locked ? (
				<div className="menu-backdrop" onMouseDown={closeMenu}>
					<div
						className="context-menu book-plus-menu"
						role="menu"
						aria-label="＋"
						style={{ left: menu.x, top: menu.y }}
						onMouseDown={(event) => event.stopPropagation()}
					>
						<button type="button" role="menuitem" onClick={() => pickBook()}>
							<span>{zh.openFolderMenu}</span>
							<span className="menu-shortcut" aria-hidden="true">
								⌘O
							</span>
						</button>
						<button type="button" role="menuitem" onClick={() => pickBook()}>
							<span>{zh.newBookMenu}</span>
						</button>
						{menu.data.icloudBooks.length ? (
							<>
								<hr />
								<div className="menu-group-label" role="presentation">
									{zh.icloudBooks}
								</div>
								{menu.data.icloudBooks.map((item) => (
									<button key={`icloud:${item.root}`} type="button" role="menuitem" onClick={() => pickBook(item.root)}>
										<span>{item.name}</span>
									</button>
								))}
							</>
						) : null}
						{menu.data.recent.length ? (
							<>
								<hr />
								<div className="menu-group-label" role="presentation">
									{zh.recent}
								</div>
								{menu.data.recent.map((item) => (
									<button key={`recent:${item.root}`} type="button" role="menuitem" onClick={() => pickBook(item.root)}>
										<span>{item.name}</span>
									</button>
								))}
							</>
						) : null}
					</div>
				</div>
			) : null}
			{state.locked ? <BlockingOverlay /> : null}
		</>
	);
}
