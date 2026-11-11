// Every user-facing string passed to vscode.l10n.t (or to the report's `t`)
// needs a Chinese translation, and the bundle should hold nothing else.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const full = path.join(dir, d.name);
		if (d.isDirectory()) {
			return d.name === 'test' ? [] : sourceFiles(full);
		}
		return full.endsWith('.ts') ? [full] : [];
	});
}

function messages(): Set<string> {
	const found = new Set<string>();
	for (const file of sourceFiles(path.join(root, 'src'))) {
		const source = fs.readFileSync(file, 'utf8');
		for (const m of source.matchAll(/(?:l10n\.t|\bt)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
			found.add(m[1].replace(/\\(.)/g, '$1'));
		}
	}
	return found;
}

test('the zh-cn bundle translates every message and nothing else', () => {
	const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.zh-cn.json'), 'utf8')) as Record<string, string>;
	const used = messages();
	assert.ok(used.size > 50, `found ${used.size} messages`);
	assert.deepEqual([...used].filter((m) => !(m in bundle)), [], 'missing translations');
	assert.deepEqual(Object.keys(bundle).filter((m) => !used.has(m)), [], 'unused translations');
});

test('package.nls files have the same keys and cover the manifest', () => {
	const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
	const zh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
	const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	const used = new Set(Array.from(manifest.matchAll(/"%([^%"]+)%"/g), (m) => m[1]));
	assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
	assert.deepEqual([...used].filter((k) => !(k in en)), []);
	assert.deepEqual(Object.keys(en).filter((k) => !used.has(k)), []);
});
