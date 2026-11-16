import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PROVIDERS, type ProviderId } from '../../llm/providers';
import type { AppInfo, SettingKey, Settings } from '../../shared/api';
import type { LineHeightLevel, ParagraphSpacingLevel, ThemeSetting } from '../../shared/defaults';
import { jsonSettings, LINE_HEIGHT_VALUES, saveSettingText, settingGroups, type SettingsCategoryId } from '../../shared/settings';
import { errorMessage } from '../errors';
import { Popover } from '../scaffold/Popover';
import { zh } from '../strings';
import { applyTheme } from '../theme';
import { availableFontOptions } from './fonts';

interface SliderSpec {
	min: number;
	max: number;
	step: number;
	format(value: number): string;
}

const SLIDERS: Partial<Record<SettingKey, SliderSpec>> = {
	'editor.fontSize': { min: 12, max: 28, step: 1, format: (v) => String(v) },
	'editor.lineWidth': { min: 24, max: 56, step: 1, format: (v) => `${v} ${zh.words}` },
	'editor.headingFontSize': { min: 16, max: 36, step: 1, format: (v) => String(v) },
	'editor.dailyWordGoal': { min: 0, max: 10000, step: 100, format: (v) => (v === 0 ? zh.noGoal : `${v.toLocaleString()} ${zh.words}`) },
	'editor.dayStartHour': { min: 0, max: 23, step: 1, format: (v) => `${v}:00` },
	debounceMs: { min: 100, max: 3000, step: 50, format: (v) => `${v} ms` },
	maxSuggestionChars: { min: 20, max: 500, step: 10, format: (v) => `${v} ${zh.words}` },
	'usage.dailyLimitUsd': { min: 0, max: 20, step: 0.5, format: (v) => (v === 0 ? zh.unlimited : `$${v}`) },
	'assistant.snapshots.keep': { min: 5, max: 200, step: 5, format: (v) => String(v) },
	'snapshots.intervalMinutes': { min: 0, max: 60, step: 1, format: (v) => (v === 0 ? zh.off : `${v} min`) },
	'snapshots.keep': { min: 10, max: 300, step: 10, format: (v) => String(v) },
	'context.beforeChars': { min: 500, max: 20000, step: 500, format: (v) => v.toLocaleString() },
	'context.afterChars': { min: 0, max: 2000, step: 50, format: (v) => v.toLocaleString() },
	'context.alwaysChars': { min: 0, max: 10000, step: 250, format: (v) => v.toLocaleString() },
	'context.matchedChars': { min: 0, max: 10000, step: 250, format: (v) => v.toLocaleString() },
	'context.entryChars': { min: 100, max: 5000, step: 100, format: (v) => v.toLocaleString() },
	'context.bookOutlineChars': { min: 0, max: 5000, step: 100, format: (v) => v.toLocaleString() },
	'context.levelOutlineChars': { min: 0, max: 5000, step: 100, format: (v) => v.toLocaleString() },
	'context.outlineChars': { min: 0, max: 5000, step: 100, format: (v) => v.toLocaleString() },
	'context.nextNodeChars': { min: 0, max: 2000, step: 50, format: (v) => v.toLocaleString() },
	'position.updateChars': { min: 0, max: 5000, step: 100, format: (v) => (v === 0 ? zh.off : v.toLocaleString()) },
	'context.previousChapters': { min: 0, max: 10, step: 1, format: (v) => String(v) },
	'context.previousChapterChars': { min: 0, max: 5000, step: 100, format: (v) => v.toLocaleString() },
};

const SUBTITLES: Partial<Record<SettingKey, string>> = {
	'editor.firstLineIndent': zh.settingSubtitles.firstLineIndent,
	'editor.headingCenter': zh.settingSubtitles.headingCenter,
	'editor.focusParagraph': zh.settingSubtitles.focusParagraph,
	'editor.autoPair': zh.settingSubtitles.autoPair,
	'editor.centerLine': zh.settingSubtitles.centerLine,
	'editor.dayStartHour': zh.settingSubtitles.dayStartHour,
};

const CATEGORIES: { id: SettingsCategoryId; icon: string; color: string; title: string }[] = [
	{ id: 'editor', icon: '文', color: '#c7643a', title: zh.settingsCategories.editor },
	{ id: 'appearance', icon: '◐', color: '#6b5bd2', title: zh.settingsCategories.appearance },
	{ id: 'continuation', icon: '✎', color: '#3c8d5c', title: zh.settingsCategories.continuation },
	{ id: 'assistant', icon: '◎', color: '#3d6fd6', title: zh.settingsCategories.assistant },
	{ id: 'usage', icon: '¥', color: '#b88a2a', title: zh.settingsCategories.usage },
	{ id: 'icloud', icon: '☁', color: '#4a90c2', title: zh.settingsCategories.icloud },
	{ id: 'about', icon: 'i', color: '#666666', title: zh.settingsCategories.about },
];

function WritingPreview({ settings }: { settings: Settings }) {
	const lh = LINE_HEIGHT_VALUES[settings['editor.lineHeight']] ?? 1.95;
	const classes = [
		'settings-preview',
		`spacing-${settings['editor.paragraphSpacing']}`,
		settings['editor.firstLineIndent'] ? 'indent-enabled' : '',
		settings['editor.headingCenter'] ? 'heading-center' : '',
		settings['editor.focusParagraph'] ? 'focus-paragraph' : '',
	]
		.filter(Boolean)
		.join(' ');
	return (
		<div
			className={classes}
			aria-label="预览"
			style={
				{
					'--writing-font': settings['editor.fontFamily'],
					'--writing-size': `${settings['editor.fontSize']}px`,
					'--writing-lh': String(lh),
					'--heading-size': `${settings['editor.headingFontSize']}px`,
					'--line-chars': String(settings['editor.lineWidth']),
				} as CSSProperties
			}
		>
			<div className="settings-preview-page">
				<div className="preview-heading dim-paragraph">第2章　灯塔</div>
				<p className="dim-paragraph">周伯的旧屋在镇子东头，门前的石阶长满了青苔。林小满敲了三下，没人应。</p>
				<p className="active-paragraph">
					身后有人说话。林小满回头，是陆青，拎着一只空鱼篓，裤脚还在滴水。
					<span className="preview-caret" aria-hidden="true" />
				</p>
				<p className="dim-paragraph">「你怎么在这儿？」</p>
			</div>
		</div>
	);
}

function StringField({
	id,
	labelText,
	initialValue,
	placeholder,
	commit,
}: {
	id: string;
	labelText: string;
	initialValue: string;
	placeholder?: string;
	commit(next: string): void;
}) {
	const [draft, setDraft] = useState(initialValue);
	const composing = useRef(false);
	useEffect(() => {
		if (!composing.current) {
			setDraft(initialValue);
		}
	}, [initialValue]);
	return (
		<input
			id={id}
			type="text"
			className="settings-text-input"
			aria-label={labelText}
			placeholder={placeholder}
			autoComplete="off"
			value={draft}
			onCompositionStart={() => {
				composing.current = true;
			}}
			onCompositionEnd={(event) => {
				composing.current = false;
				const next = event.currentTarget.value;
				setDraft(next);
				commit(next);
			}}
			onChange={(event) => {
				const next = event.target.value;
				setDraft(next);
				if (!composing.current) {
					commit(next);
				}
			}}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) {
					return;
				}
				if (event.key === 'Enter') {
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

export function SettingsWindow() {
	const [settings, update] = useState<Settings>();
	const [category, setCategory] = useState<SettingsCategoryId>('editor');
	const [info, setInfo] = useState<AppInfo>();
	const [hasKey, setHasKey] = useState(false);
	const [editingJson, setEditingJson] = useState<SettingKey>();
	const [editingKey, setEditingKey] = useState(false);
	const [value, setValue] = useState('');
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const [customFontOpen, setCustomFontOpen] = useState(false);
	const customFontRef = useRef<HTMLInputElement>(null);
	const fontOptions = useMemo(() => availableFontOptions(), []);

	useEffect(() => {
		void window.novel.settings.get().then(update);
		void window.novel.settings.info().then(setInfo);
		const off = window.novel.settings.onChanged(update);
		const commands = window.novel.window.onCommand((command) => {
			if (command === 'closeTab') {
				window.novel.window.close();
			}
		});
		return () => {
			off();
			commands();
		};
	}, []);

	useEffect(() => {
		if (settings) {
			applyTheme(settings['appearance.theme']);
		}
	}, [settings?.['appearance.theme']]);

	const provider = settings?.provider as ProviderId | undefined;
	useEffect(() => {
		let active = true;
		if (provider) {
			void window.novel.secrets.has(provider).then((has) => {
				if (active) {
					setHasKey(has);
				}
			});
		}
		return () => {
			active = false;
		};
	}, [provider]);

	if (!settings || !provider) {
		return null;
	}

	const label = (key: SettingKey) => zh.settingLabels[key as keyof typeof zh.settingLabels];
	const closeDialog = () => {
		setEditingJson(undefined);
		setEditingKey(false);
		setValue('');
		setError('');
	};
	const set = <K extends SettingKey>(key: K, nextValue: Settings[K]) => {
		setError('');
		void window.novel.settings.set(key, nextValue).catch((err) => setError(errorMessage(err)));
	};

	const commitJson = async () => {
		if (!editingJson || pending) {
			return;
		}
		setPending(true);
		try {
			await saveSettingText(editingJson, value, window.novel.settings.set);
			closeDialog();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setPending(false);
		}
	};

	const commitApiKey = async () => {
		if (pending) {
			return;
		}
		setPending(true);
		try {
			await window.novel.secrets.set(provider, value);
			setHasKey(Boolean(value));
			closeDialog();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setPending(false);
		}
	};

	const renderSegmented = <T extends string>(key: SettingKey, choices: { value: T; title: string }[]) => {
		const id = `setting-${key}`;
		const title = label(key);
		const sub = SUBTITLES[key];
		const current = String(settings[key]) as T;
		return (
			<div key={key} className="settings-item">
				<label id={`${id}-label`} className="settings-label">
					<span>{title}</span>
					{sub ? <span className="settings-sub">{sub}</span> : null}
				</label>
				<div role="radiogroup" aria-labelledby={`${id}-label`} className="settings-segs">
					{choices.map((choice, idx) => {
						const active = current === choice.value;
						return (
							<button
								key={choice.value}
								type="button"
								role="radio"
								aria-checked={active}
								tabIndex={active ? 0 : -1}
								className={active ? 'on' : ''}
								onClick={() => set(key, choice.value as Settings[typeof key])}
								onKeyDown={(event) => {
									if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
										event.preventDefault();
										const nextIdx = (idx + 1) % choices.length;
										set(key, choices[nextIdx].value as Settings[typeof key]);
										(event.currentTarget.parentElement?.children[nextIdx] as HTMLElement | undefined)?.focus();
									} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
										event.preventDefault();
										const prevIdx = (idx - 1 + choices.length) % choices.length;
										set(key, choices[prevIdx].value as Settings[typeof key]);
										(event.currentTarget.parentElement?.children[prevIdx] as HTMLElement | undefined)?.focus();
									}
								}}
							>
								{choice.title}
							</button>
						);
					})}
				</div>
			</div>
		);
	};

	const renderRow = (key: SettingKey) => {
		const id = `setting-${key}`;
		const title = label(key);
		const sub = SUBTITLES[key];
		const current = settings[key];

		if (key === 'editor.fontFamily') {
			const currentFont = settings['editor.fontFamily'];
			const inPreset = fontOptions.some((opt) => opt.value === currentFont);
			const showCustom = customFontOpen || !inPreset;
			return (
				<div key={key} className="settings-item-stack">
					<div className="settings-item">
						<label htmlFor={id} className="settings-label">
							<span>{title}</span>
						</label>
						<select
							id={id}
							aria-label={title}
							className="settings-select"
							value={showCustom ? '__other__' : currentFont}
							onChange={(event) => {
								const chosen = event.target.value;
								if (chosen === '__other__') {
									setCustomFontOpen(true);
									requestAnimationFrame(() => customFontRef.current?.focus());
								} else {
									setCustomFontOpen(false);
									set('editor.fontFamily', chosen);
								}
							}}
						>
							{fontOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.title}
								</option>
							))}
							<option value="__other__">{zh.fonts.other}</option>
						</select>
					</div>
					{showCustom ? (
						<div className="settings-item settings-sub-item">
							<label htmlFor={`${id}-custom`} className="settings-label">
								<span>{zh.fonts.customLabel}</span>
							</label>
							<CustomFontInput
								id={`${id}-custom`}
								inputRef={customFontRef}
								value={inPreset && customFontOpen ? '' : currentFont}
								commit={(next) => {
									const trimmed = next.trim();
									if (trimmed) {
										set('editor.fontFamily', trimmed);
									}
								}}
							/>
						</div>
					) : null}
				</div>
			);
		}

		if (key === 'editor.lineHeight') {
			return renderSegmented<LineHeightLevel>(key, [
				{ value: 'tight', title: zh.lineHeights.tight },
				{ value: 'normal', title: zh.lineHeights.normal },
				{ value: 'loose', title: zh.lineHeights.loose },
			]);
		}
		if (key === 'editor.paragraphSpacing') {
			return renderSegmented<ParagraphSpacingLevel>(key, [
				{ value: 'none', title: zh.paragraphSpacings.none },
				{ value: 'half', title: zh.paragraphSpacings.half },
				{ value: 'full', title: zh.paragraphSpacings.full },
			]);
		}
		if (key === 'appearance.theme') {
			return renderSegmented<ThemeSetting>(key, [
				{ value: 'system', title: zh.themes.system },
				{ value: 'light', title: zh.themes.light },
				{ value: 'dark', title: zh.themes.dark },
			]);
		}
		if (key === 'trigger') {
			return renderSegmented<'auto' | 'manual'>(key, [
				{ value: 'auto', title: zh.auto },
				{ value: 'manual', title: zh.manual },
			]);
		}

		if (key === 'provider' || key === 'assistant.agent') {
			const options =
				key === 'provider'
					? Object.keys(PROVIDERS).map((pid) => ({ value: pid, title: zh.providers[pid as ProviderId] }))
					: [
							{ value: 'claude', title: 'Claude Code' },
							{ value: 'custom', title: zh.settingLabels['assistant.command'] },
						];
			return (
				<div key={key} className="settings-item">
					<label htmlFor={id} className="settings-label">
						<span>{title}</span>
					</label>
					<select
						id={id}
						aria-label={title}
						className="settings-select"
						value={String(current)}
						onChange={(event) => set(key, event.target.value as Settings[typeof key])}
					>
						{options.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.title}
							</option>
						))}
					</select>
				</div>
			);
		}

		if (typeof current === 'boolean') {
			return (
				<div key={key} className="settings-item">
					<label htmlFor={id} className="settings-label">
						<span>{title}</span>
						{sub ? <span className="settings-sub">{sub}</span> : null}
					</label>
					<button
						id={id}
						type="button"
						role="switch"
						aria-checked={current}
						aria-label={title}
						className={`settings-switch ${current ? 'on' : ''}`}
						onClick={() => set(key, !current as Settings[typeof key])}
					/>
				</div>
			);
		}

		const slider = SLIDERS[key];
		if (slider && typeof current === 'number') {
			const min = Math.min(slider.min, current);
			const max = Math.max(slider.max, current);
			const step = Number.isInteger(slider.step)
				? current % slider.step === 0
					? slider.step
					: 1
				: Math.abs(current / slider.step - Math.round(current / slider.step)) < 1e-9
					? slider.step
					: 0.05;
			return (
				<div key={key} className="settings-item">
					<label htmlFor={id} className="settings-label">
						<span>{title}</span>
						{sub ? <span className="settings-sub">{sub}</span> : null}
					</label>
					<div className="settings-slider-wrap">
						<input
							id={id}
							type="range"
							aria-label={title}
							className="settings-slider"
							min={min}
							max={max}
							step={step}
							value={current}
							onChange={(event) => set(key, Number(event.target.value) as Settings[typeof key])}
						/>
						<output htmlFor={id} className="settings-val">
							{slider.format(current)}
						</output>
					</div>
				</div>
			);
		}

		if (jsonSettings.includes(key)) {
			return (
				<div key={key} className="settings-item">
					<label htmlFor={id} className="settings-label">
						<span>{title}</span>
					</label>
					<button
						id={id}
						type="button"
						className="settings-action-btn"
						aria-label={title}
						onClick={() => {
							setEditingKey(false);
							setEditingJson(key);
							setValue(JSON.stringify(current, null, 2));
							setError('');
						}}
					>
						{Array.isArray(current) ? `${current.length} 项` : `${Object.keys(current as object).length} 项`}
					</button>
				</div>
			);
		}

		return (
			<div key={key} className="settings-item">
				<label htmlFor={id} className="settings-label">
					<span>{title}</span>
				</label>
				<StringField id={id} labelText={title} initialValue={String(current)} commit={(next) => set(key, next as Settings[typeof key])} />
			</div>
		);
	};

	const activeCategoryMeta = CATEGORIES.find((c) => c.id === category)!;
	const groupsForCategory = settingGroups.filter((group) => group.category === category);

	return (
		<div className="settings-window">
			<aside className="settings-side" role="tablist" aria-label={zh.settings} aria-orientation="vertical">
				{CATEGORIES.map((item, idx) => {
					const active = item.id === category;
					return (
						<button
							key={item.id}
							type="button"
							role="tab"
							id={`settings-tab-${item.id}`}
							aria-selected={active}
							aria-controls={`settings-pane-${item.id}`}
							tabIndex={active ? 0 : -1}
							className={`settings-nav-item ${active ? 'on' : ''}`}
							onClick={() => {
								closeDialog();
								setCategory(item.id);
							}}
							onKeyDown={(event) => {
								if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
									event.preventDefault();
									const delta = event.key === 'ArrowDown' ? 1 : -1;
									const nextIdx = (idx + delta + CATEGORIES.length) % CATEGORIES.length;
									closeDialog();
									setCategory(CATEGORIES[nextIdx].id);
									(event.currentTarget.parentElement?.children[nextIdx] as HTMLElement | undefined)?.focus();
								}
							}}
						>
							<span className="settings-nav-icon" style={{ background: item.color }} aria-hidden="true">
								{item.icon}
							</span>
							<span>{item.title}</span>
						</button>
					);
				})}
			</aside>
			<main className="settings-pane" role="tabpanel" id={`settings-pane-${category}`} aria-labelledby={`settings-tab-${category}`}>
				<div className="settings-pane-inner">
					<h1 className="settings-pane-title">{activeCategoryMeta.title}</h1>
					{category === 'editor' || category === 'appearance' ? <WritingPreview settings={settings} /> : null}

					{groupsForCategory.map((group) => (
						<section key={group.name} className="settings-section">
							<h2 className="settings-group-title">{group.name}</h2>
							<div className="settings-group">
								{group.keys.map((key) => renderRow(key))}
								{category === 'continuation' && group.name === zh.settingsGroups.model ? (
									<div className="settings-item">
										<label htmlFor={editingKey ? 'setting-api-key-input' : 'setting-api-key-btn'} className="settings-label">
											<span>{zh.apiKey}</span>
										</label>
										{editingKey ? (
											<div className="inline-setting">
												<input
													id="setting-api-key-input"
													autoFocus
													aria-label={zh.apiKey}
													type="password"
													autoComplete="off"
													value={value}
													disabled={pending}
													onChange={(event) => setValue(event.target.value)}
													onKeyDown={(event) => {
														if (event.nativeEvent.isComposing) {
															return;
														}
														if (event.key === 'Enter') {
															event.preventDefault();
															void commitApiKey();
														} else if (event.key === 'Escape') {
															closeDialog();
														}
													}}
												/>
												<button type="button" disabled={pending} onClick={() => void commitApiKey()}>
													{zh.confirm}
												</button>
												<button type="button" disabled={pending} onClick={closeDialog}>
													{zh.cancel}
												</button>
											</div>
										) : (
											<span className="key-controls">
												<span>{hasKey ? zh.keySet : zh.keyUnset}</span>
												<button
													id="setting-api-key-btn"
													type="button"
													aria-label={`${zh.apiKey} ${hasKey ? zh.replaceKey : zh.setKey}`}
													onClick={() => {
														setEditingJson(undefined);
														setEditingKey(true);
														setValue('');
														setError('');
													}}
												>
													{hasKey ? zh.replaceKey : zh.setKey}
												</button>
												{hasKey ? (
													<button
														type="button"
														onClick={() =>
															void window.novel.secrets
																.clear(provider)
																.then(() => setHasKey(false))
																.catch((err) => setError(errorMessage(err)))
														}
													>
														{zh.clear}
													</button>
												) : null}
											</span>
										)}
									</div>
								) : null}
							</div>
						</section>
					))}

					{category === 'icloud' ? (
						<section className="settings-section">
							<h2 className="settings-group-title">{zh.settingsGroups.icloud}</h2>
							<div className="settings-group">
								<div className="settings-item">
									<span className="settings-label">{zh.icloudStatus}</span>
									<span className="settings-static-val">{info?.icloudAvailable ? zh.icloudAvailableLabel : zh.icloudUnavailableLabel}</span>
								</div>
								<div className="settings-item">
									<label htmlFor="setting-icloud-reveal" className="settings-label">
										<span>{zh.icloudBooksFolder}</span>
										{info ? <span className="settings-sub">iCloud Drive/{info.icloudFolderName}</span> : null}
									</label>
									<button
										id="setting-icloud-reveal"
										type="button"
										aria-label={zh.reveal}
										className="settings-action-btn"
										disabled={!info?.icloudAvailable}
										onClick={() => {
											void window.novel.settings.revealICloud();
										}}
									>
										{zh.reveal}
									</button>
								</div>
							</div>
						</section>
					) : null}

					{category === 'about' ? (
						<section className="settings-section">
							<h2 className="settings-group-title">{zh.settingsGroups.about}</h2>
							<div className="settings-group">
								<div className="settings-item">
									<span className="settings-label">{zh.aboutAppName}</span>
									<span className="settings-static-val">{info?.appName ?? ''}</span>
								</div>
								<div className="settings-item">
									<span className="settings-label">{zh.aboutVersion}</span>
									<span className="settings-static-val">{info?.version ?? ''}</span>
								</div>
							</div>
						</section>
					) : null}

					{error && !editingJson ? (
						<p role="alert" className="settings-error">
							{error}
						</p>
					) : null}
				</div>
			</main>

			{editingJson ? (
				<Popover title={label(editingJson)} close={closeDialog} submit={() => void commitJson()} multiline pending={pending}>
					<label htmlFor="json-setting-textarea" className="settings-sub">
						{label(editingJson)}
					</label>
					<textarea
						id="json-setting-textarea"
						aria-label={label(editingJson)}
						rows={12}
						value={value}
						onChange={(event) => setValue(event.target.value)}
					/>
					{error ? <p role="alert">{error}</p> : null}
				</Popover>
			) : null}
		</div>
	);
}

function CustomFontInput({
	id,
	inputRef,
	value,
	commit,
}: {
	id: string;
	inputRef: React.RefObject<HTMLInputElement | null>;
	value: string;
	commit(next: string): void;
}) {
	const [draft, setDraft] = useState(value);
	const composing = useRef(false);
	useEffect(() => {
		if (!composing.current) {
			setDraft(value);
		}
	}, [value]);
	return (
		<input
			ref={inputRef}
			id={id}
			type="text"
			className="settings-text-input"
			aria-label={zh.fonts.customLabel}
			placeholder={zh.fonts.customPlaceholder}
			autoComplete="off"
			value={draft}
			onCompositionStart={() => {
				composing.current = true;
			}}
			onCompositionEnd={(event) => {
				composing.current = false;
				const next = event.currentTarget.value;
				setDraft(next);
				commit(next);
			}}
			onChange={(event) => {
				const next = event.target.value;
				setDraft(next);
				if (!composing.current) {
					commit(next);
				}
			}}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) {
					return;
				}
				if (event.key === 'Enter') {
					commit(draft);
					event.currentTarget.blur();
				}
			}}
		/>
	);
}
