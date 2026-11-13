import { contextBridge, ipcRenderer } from 'electron';
import { channels as c, type AppAPI } from '../shared/api';
const listen = <T>(channel: string, listener: (value: T) => void) => {
	const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
};
const api: AppAPI = {
	book: {
		onOpenResult: (listener) => listen(c.openResult, listener),
		open: (root) => ipcRenderer.invoke(c.bookOpen, root),
		read: (path) => ipcRenderer.invoke(c.bookRead, path),
		save: (path, text, base, force) => ipcRenderer.invoke(c.bookSave, path, text, base, force),
		onChanged: (listener) => listen(c.bookChanged, listener),
		onFileChanged: (listener) => listen(c.fileChanged, listener),
	},
	completion: {
		request: (input) => ipcRenderer.invoke(c.completionRequest, input),
		cancel: (id) => ipcRenderer.send(c.completionCancel, id),
	},
	settings: {
		get: () => ipcRenderer.invoke(c.settingsGet),
		set: (key, value) => ipcRenderer.invoke(c.settingsSet, key, value),
		open: () => ipcRenderer.invoke(c.settingsOpen),
		onChanged: (listener) => listen(c.settingsChanged, listener),
	},
	secrets: {
		has: (provider) => ipcRenderer.invoke(c.secretsHas, provider),
		set: (provider, key) => ipcRenderer.invoke(c.secretsSet, provider, key),
		clear: (provider) => ipcRenderer.invoke(c.secretsClear, provider),
	},
	usage: { onChanged: (listener) => listen(c.usageChanged, listener) },
	window: {
		bootstrap: () => ipcRenderer.invoke(c.bootstrap),
		saveSession: (session) => ipcRenderer.invoke(c.session, session),
		flushed: () => ipcRenderer.send(c.flushed),
		close: () => ipcRenderer.send(c.close),
		onCommand: (listener) => listen(c.command, listener),
	},
};
contextBridge.exposeInMainWorld('novel', api);
