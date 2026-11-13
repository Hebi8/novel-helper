// Run contract tests against a temporary copy of the examples.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tests-'));
let result;
try {
	for (const folder of ['out', 'examples', 'dist/native']) {
		fs.cpSync(folder, path.join(root, folder), { recursive: true });
	}
	fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
	for (const file of ['package-lock.json', 'THIRD-PARTY-NOTICES.md']) {
		fs.copyFileSync(file, path.join(root, file));
	}
	fs.copyFileSync('package.json', path.join(root, 'package.json'));
	result = spawnSync(
		process.execPath,
		['--test', '--test-timeout=30000', ...(process.argv.length > 2 ? process.argv.slice(2) : ['out/test/**/*.test.js'])],
		{ cwd: root, stdio: 'inherit' },
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = result.status ?? 1;
