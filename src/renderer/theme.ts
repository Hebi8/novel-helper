import type { ThemeSetting } from '../shared/defaults';

export function applyTheme(theme: ThemeSetting): void {
	if (theme === 'light' || theme === 'dark') {
		document.documentElement.dataset.theme = theme;
	} else {
		delete document.documentElement.dataset.theme;
	}
}
