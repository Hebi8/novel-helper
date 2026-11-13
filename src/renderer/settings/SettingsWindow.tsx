import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, type ProviderId } from '../../llm/providers';
import type { Settings, SettingKey } from '../../shared/api';
import { settingGroups, saveSettingText, jsonSettings } from '../../shared/settings';
import { Popover } from '../scaffold/Popover';
import { errorMessage } from '../errors';
import { zh } from '../strings';
export function SettingsWindow() {
	const [settings, update] = useState<Settings>();
	const [hasKey, setHasKey] = useState(false);
	const [editing, setEditing] = useState<SettingKey | 'key'>();
	const [value, setValue] = useState('');
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const composing = useRef(false);
	useEffect(() => {
		void window.novel.settings.get().then(update);
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
	const close = () => {
		setEditing(undefined);
		setValue('');
		setError('');
	};
	const set = (key: SettingKey, value: Settings[SettingKey]) => {
		void window.novel.settings.set(key, value).catch((error) => setError(errorMessage(error)));
	};
	const edit = (key: SettingKey | 'key') => {
		setEditing(key);
		setValue(key === 'key' ? '' : jsonSettings.includes(key) ? JSON.stringify(settings[key], null, 2) : String(settings[key]));
		setError('');
	};
	const commit = async () => {
		if (!editing || pending || composing.current) {
			return;
		}
		setPending(true);
		try {
			if (editing === 'key') {
				await window.novel.secrets.set(provider, value);
				setHasKey(!!value);
			} else {
				await saveSettingText(editing, value, window.novel.settings.set);
			}
			close();
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setPending(false);
		}
	};
	const inline = (key: SettingKey | 'key') => (
		<div className="inline-setting">
			<input
				autoFocus
				aria-label={key === 'key' ? zh.apiKey : label(key)}
				type={key === 'key' ? 'password' : 'text'}
				autoComplete="off"
				value={value}
				disabled={pending}
				onChange={(event) => setValue(event.target.value)}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
						return;
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						void commit();
					} else if (event.key === 'Escape') {
						close();
					}
				}}
			/>
			<button disabled={pending} onClick={() => void commit()}>
				{zh.confirm}
			</button>
			<button disabled={pending} onClick={close}>
				{zh.cancel}
			</button>
		</div>
	);
	return (
		<main className="settings-window">
			<h1>{zh.settings}</h1>
			{settingGroups.map((group) => (
				<section key={group.name}>
					<h2>{group.name}</h2>
					<div className="settings-rows">
						{group.keys.map((key) => {
							const current = settings[key];
							const options =
								key === 'provider'
									? Object.keys(PROVIDERS).map((id) => ({ value: id, title: zh.providers[id as ProviderId] }))
									: key === 'trigger'
										? [
												{ value: 'auto', title: zh.auto },
												{ value: 'manual', title: zh.manual },
											]
										: key === 'assistant.agent'
											? [
													{ value: 'claude', title: 'Claude Code' },
													{ value: 'custom', title: zh.settingLabels['assistant.command'] },
												]
											: undefined;
							return (
								<div key={key} className="setting">
									<span>{label(key)}</span>
									{options ? (
										<select
											aria-label={label(key)}
											value={String(current)}
											onChange={(event) => {
												close();
												set(key, event.target.value);
											}}
										>
											{options.map((option) => (
												<option key={option.value} value={option.value}>
													{option.title}
												</option>
											))}
										</select>
									) : typeof current === 'boolean' ? (
										<button aria-label={label(key)} aria-pressed={current} onClick={() => set(key, !current)}>
											{current ? zh.on : zh.off}
										</button>
									) : editing === key && !jsonSettings.includes(key) ? (
										inline(key)
									) : (
										<button className="setting-value" aria-label={label(key)} onClick={() => edit(key)}>
											{typeof current === 'object' ? JSON.stringify(current) : String(current) || '—'}
										</button>
									)}
								</div>
							);
						})}
						{group.name === zh.settingsModel ? (
							<div className="setting">
								<span>{zh.apiKey}</span>
								{editing === 'key' ? (
									inline('key')
								) : (
									<span className="key-controls">
										<span>{hasKey ? zh.keySet : zh.keyUnset}</span>
										<button onClick={() => edit('key')}>{hasKey ? zh.replaceKey : zh.setKey}</button>
										{hasKey ? (
											<button
												onClick={() =>
													void window.novel.secrets
														.clear(provider)
														.then(() => setHasKey(false))
														.catch((error) => setError(errorMessage(error)))
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
			{error ? <p role="alert">{error}</p> : null}
			{editing && editing !== 'key' && jsonSettings.includes(editing) ? (
				<Popover title={label(editing)} close={close} submit={() => void commit()} multiline pending={pending}>
					<textarea aria-label={label(editing)} rows={12} value={value} onChange={(event) => setValue(event.target.value)} />
					{error ? <p role="alert">{error}</p> : null}
				</Popover>
			) : null}
		</main>
	);
}
