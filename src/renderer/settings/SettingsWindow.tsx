import { useEffect, useState } from 'react';
import { PROVIDERS, type ProviderId } from '../../llm/providers';
import type { Settings } from '../../shared/api';
import { zh } from '../strings';
export function SettingsWindow() {
	useEffect(
		() =>
			window.novel.window.onCommand((command) => {
				if (command === 'closeTab') {
					window.novel.window.close();
				}
			}),
		[],
	);
	const [settings, update] = useState<Settings>();
	const [hasKey, setHasKey] = useState(false);
	const [editing, setEditing] = useState<'model' | 'key'>();
	const [value, setValue] = useState('');
	const [error, setError] = useState('');
	useEffect(() => {
		void window.novel.settings.get().then(update);
		return window.novel.settings.onChanged(update);
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
	const set = window.novel.settings.set;
	const commit = async () => {
		try {
			if (editing === 'model') {
				await set(`${provider}.model`, value);
			} else {
				await window.novel.secrets.set(provider, value);
				setHasKey(!!value);
			}
			setValue('');
			setEditing(undefined);
			setError('');
		} catch (error) {
			setError(String(error));
		}
	};
	return (
		<main className="settings-window">
			<h1>{zh.settings}</h1>
			<div className="settings-rows">
				<button
					className="setting"
					onClick={() => {
						void set('enabled', !settings.enabled);
					}}
				>
					<span>{zh.continuation}</span>
					<strong>{settings.enabled ? zh.on : zh.off}</strong>
				</button>
				<button
					className="setting"
					onClick={() => {
						void set('trigger', settings.trigger === 'auto' ? 'manual' : 'auto');
					}}
				>
					<span>
						{zh.auto} / {zh.manual}
					</span>
					<strong>{settings.trigger === 'auto' ? zh.auto : zh.manual}</strong>
				</button>
				<label className="setting">
					<span>{zh.provider}</span>
					<select
						value={provider}
						onChange={(e) => {
							setEditing(undefined);
							setValue('');
							void set('provider', e.target.value);
						}}
					>
						{Object.keys(PROVIDERS).map((id) => (
							<option key={id} value={id}>
								{zh.providers[id as ProviderId]}
							</option>
						))}
					</select>
				</label>
				<button
					className="setting"
					onClick={() => {
						setEditing('model');
						setValue(settings[`${provider}.model`]);
					}}
				>
					<span>{zh.model}</span>
					<strong>{settings[`${provider}.model`] || PROVIDERS[provider].defaultModel || '—'}</strong>
				</button>
				<div className="setting">
					<span>{zh.apiKey}</span>
					<span className="key-controls">
						<span>{hasKey ? zh.keySet : zh.keyUnset}</span>
						<button
							onClick={() => {
								setEditing('key');
								setValue('');
							}}
						>
							{hasKey ? zh.replaceKey : zh.setKey}
						</button>
						{hasKey ? (
							<button
								onClick={() => {
									void window.novel.secrets.clear(provider).then(() => setHasKey(false));
								}}
							>
								{zh.clear}
							</button>
						) : null}
					</span>
				</div>
			</div>
			{editing ? (
				<form
					className="setting-edit"
					onSubmit={(event) => {
						event.preventDefault();
						void commit();
					}}
				>
					<input
						aria-label={editing === 'model' ? zh.model : zh.apiKey}
						autoFocus
						type={editing === 'key' ? 'password' : 'text'}
						autoComplete="off"
						value={value}
						onChange={(e) => setValue(e.target.value)}
					/>
					<button type="submit">{zh.confirm}</button>
					<button
						type="button"
						onClick={() => {
							setEditing(undefined);
							setValue('');
						}}
					>
						{zh.cancel}
					</button>
				</form>
			) : null}
			{error ? <p role="alert">{error}</p> : null}
		</main>
	);
}
