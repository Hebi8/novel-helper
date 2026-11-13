import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
	main: {
		build: { outDir: 'dist/main' },
	},
	preload: { build: { outDir: 'dist/preload' } },
	renderer: {
		root: 'src/renderer',
		plugins: [react()],
		build: { outDir: resolve('dist/renderer'), rollupOptions: { input: resolve('src/renderer/index.html') } },
	},
});
