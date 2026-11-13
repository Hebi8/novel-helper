import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
export default defineConfig({
	main: {
		build: { outDir: 'dist/main' },
		plugins: [
			{
				name: 'notices',
				closeBundle() {
					copyFileSync('THIRD-PARTY-NOTICES.md', 'dist/THIRD-PARTY-NOTICES.md');
				},
			},
		],
	},
	preload: { build: { outDir: 'dist/preload' } },
	renderer: {
		root: 'src/renderer',
		plugins: [react()],
		build: { outDir: resolve('dist/renderer'), rollupOptions: { input: resolve('src/renderer/index.html') } },
	},
});
