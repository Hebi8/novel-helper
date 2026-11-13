const { mkdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
mkdirSync('dist/native', { recursive: true });
execFileSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', '-O2', 'native/book-fs.c', '-o', 'dist/native/book-fs'], {
	stdio: 'inherit',
});
