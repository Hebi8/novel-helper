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
	structure: {
		plan: (root, language) => ipcRenderer.invoke(c.structurePlan, root, language),
		initialize: (root, language, selected) => ipcRenderer.invoke(c.structureInitialize, root, language, selected),
		suggest: (action, path) => ipcRenderer.invoke(c.structureSuggest, action, path),
		create: (input) => ipcRenderer.invoke(c.structureCreate, input),
		trashPlan: (target) => ipcRenderer.invoke(c.structureTrashPlan, target),
		trash: (plan) => ipcRenderer.invoke(c.structureTrash, plan),
	},
	search: { find: (query) => ipcRenderer.invoke(c.bookSearch, query) },
	assistant: {
		state: () => ipcRenderer.invoke(c.assistantState),
		probe: () => ipcRenderer.invoke(c.assistantProbe),
		send: (text, context) => ipcRenderer.invoke(c.assistantSend, text, context),
		setOption: (id, value) => ipcRenderer.invoke(c.assistantSetOption, id, value),
		stop: () => ipcRenderer.invoke(c.assistantStop),
		newSession: () => ipcRenderer.invoke(c.assistantNewSession),
		answer: (id, allow) => ipcRenderer.invoke(c.assistantAnswer, id, allow),
		history: () => ipcRenderer.invoke(c.assistantHistory),
		diff: (id, path) => ipcRenderer.invoke(c.assistantDiff, id, path),
		revert: (id) => ipcRenderer.invoke(c.assistantRevert, id),
		openLink: (href) => ipcRenderer.invoke(c.assistantLink, href),
		onChanged: (listener) => listen(c.assistantChanged, listener),
	},
	reference: {
		get: () => ipcRenderer.invoke(c.referenceGet),
		set: (path, field, value) => ipcRenderer.invoke(c.loreSet, path, field, value),
		create: (name, type) => ipcRenderer.invoke(c.loreCreate, name, type),
		companion: (path, kind) => ipcRenderer.invoke(c.companionOpen, path, kind),
		quick: () => ipcRenderer.invoke(c.quickOpen),
	},
	buoys: {
		get: (chapter, text) => ipcRenderer.invoke(c.buoyGet, chapter, text),
		act: (chapter, action, node) => ipcRenderer.invoke(c.buoyAction, chapter, action, node),
		onChanged: (listener) => listen(c.buoyChanged, listener),
	},
	reports: {
		get: (kind) => ipcRenderer.invoke(c.reportGet, kind),
		onChanged: (listener) => listen(c.reportChanged, listener),
	},
	book: {
		reveal: (path) => ipcRenderer.invoke(c.bookReveal, path),
		renameTitle: (title) => ipcRenderer.invoke(c.bookRenameTitle, title),
		onOpenResult: (listener) => listen(c.openResult, listener),
		open: (root, selected) => ipcRenderer.invoke(c.bookOpen, root, selected),
		saveToICloud: () => ipcRenderer.invoke(c.bookSaveToICloud),
		watchICloud: () => ipcRenderer.invoke(c.icloudWatch),
		unwatchICloud: () => ipcRenderer.send(c.icloudUnwatch),
		onICloudChanged: (listener) => listen(c.icloudChanged, listener),
		read: (path) => ipcRenderer.invoke(c.bookRead, path),
		save: (path, text, base, force) => ipcRenderer.invoke(c.bookSave, path, text, base, force),
		conflictDiff: (path) => ipcRenderer.invoke(c.bookConflictDiff, path),
		resolveConflict: (input) => ipcRenderer.invoke(c.bookConflictResolve, input),
		onChanged: (listener) => listen(c.bookChanged, listener),
		onFileChanged: (listener) => listen(c.fileChanged, listener),
		onWordsChanged: (listener) => listen(c.wordsChanged, listener),
	},
	completion: {
		request: (input) => ipcRenderer.invoke(c.completionRequest, input),
		cancel: (id) => ipcRenderer.send(c.completionCancel, id),
	},
	settings: {
		get: () => ipcRenderer.invoke(c.settingsGet),
		set: (key, value) => ipcRenderer.invoke(c.settingsSet, key, value),
		open: () => ipcRenderer.invoke(c.settingsOpen),
		info: () => ipcRenderer.invoke(c.settingsInfo),
		revealICloud: () => ipcRenderer.invoke(c.settingsRevealICloud),
		onChanged: (listener) => listen(c.settingsChanged, listener),
	},
	secrets: {
		has: (provider) => ipcRenderer.invoke(c.secretsHas, provider),
		set: (provider, key) => ipcRenderer.invoke(c.secretsSet, provider, key),
		clear: (provider) => ipcRenderer.invoke(c.secretsClear, provider),
	},
	usage: { onChanged: (listener) => listen(c.usageChanged, listener) },
	window: {
		focus: (enabled) => ipcRenderer.invoke(c.focusSet, enabled),
		onFocusChanged: (listener) => listen(c.focusChanged, listener),
		bootstrap: () => ipcRenderer.invoke(c.bootstrap),
		saveSession: (session) => ipcRenderer.invoke(c.session, session),
		flushed: (saved = true) => ipcRenderer.send(c.flushed, saved),
		close: () => ipcRenderer.send(c.close),
		onCommand: (listener) => listen(c.command, listener),
		onNotice: (listener) => listen(c.notice, listener),
	},
	tabs: {
		state: () => ipcRenderer.invoke(c.tabsState),
		select: (id) => ipcRenderer.invoke(c.tabsSelect, id),
		selectIndex: (index) => ipcRenderer.invoke(c.tabsSelectIndex, index),
		cycle: (step) => ipcRenderer.invoke(c.tabsCycle, step),
		close: (id) => ipcRenderer.invoke(c.tabsClose, id),
		openMenu: () => ipcRenderer.invoke(c.tabsOpenMenu),
		closeMenu: () => ipcRenderer.invoke(c.tabsCloseMenu),
		openBook: (root) => ipcRenderer.invoke(c.tabsOpenBook, root),
		onChanged: (listener) => listen(c.tabsChanged, listener),
	},
};
contextBridge.exposeInMainWorld('novel', api);
