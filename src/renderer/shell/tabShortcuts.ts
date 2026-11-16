export function handleBookTabShortcut(event: KeyboardEvent, options?: { closeOnly?: boolean }): boolean {
	if (event.isComposing) {
		return false;
	}
	if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
		event.preventDefault();
		event.stopPropagation();
		void window.novel.tabs.close();
		return true;
	}
	if (options?.closeOnly) {
		return false;
	}
	if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
		event.preventDefault();
		event.stopPropagation();
		void window.novel.tabs.selectIndex(Number(event.key) - 1);
		return true;
	}
	if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
		event.preventDefault();
		event.stopPropagation();
		void window.novel.tabs.cycle(event.shiftKey ? -1 : 1);
		return true;
	}
	return false;
}
