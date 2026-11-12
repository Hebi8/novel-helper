// The packages that are bundled into the extension have to be named in
// THIRD-PARTY-NOTICES.md, at the version that is bundled and with their
// license texts: their licenses ask for that, and the file is what ships.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('every package that ships in the bundle is in the third-party notices, with its version and its license', () => {
	const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version: string; dev?: boolean }> };
	// What is not a development dependency is what esbuild puts into dist/extension.js.
	const shipped = Object.entries(lock.packages)
		.filter(([folder, entry]) => folder && !entry.dev)
		.map(([folder, entry]) => ({ folder, title: `${folder.slice('node_modules/'.length)} ${entry.version}` }));
	const notices = read('THIRD-PARTY-NOTICES.md');
	assert.deepEqual([...notices.matchAll(/^## (.+)$/gm)].map((match) => match[1]), shipped.map((one) => one.title).sort());
	for (const { folder, title } of shipped) {
		assert.ok(notices.includes(read(`${folder}/LICENSE`).trimEnd()), `the license of ${title}`);
	}
});
