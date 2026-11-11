// The usage file is shared by every window: each has its own UsageStore on
// the same directory.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { UsageStore } from '../storage/usageStore';

const MODEL = 'anthropic/claude-haiku-5-5';
const made: string[] = [];
const directory = () => {
	made.push(fs.mkdtempSync(path.join(os.tmpdir(), 'novel-helper-usage-')));
	return path.join(made.at(-1)!, 'storage');
};
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** Makes a store stop right after it has read the ledger, holding the lock, until `resume` is called. */
function pauseAfterReading(store: UsageStore): { paused: Promise<void>; resume(): void } {
	let reached!: () => void;
	let resume!: () => void;
	const paused = new Promise<void>((resolve) => (reached = resolve));
	const gate = new Promise<void>((resolve) => (resume = resolve));
	const read = store['read'].bind(store);
	let first = true;
	store['read'] = async () => {
		const ledger = await read();
		if (first) {
			first = false;
			reached();
			await gate;
		}
		return ledger;
	};
	return { paused, resume };
}

describe('UsageStore', () => {
	test('two windows adding at the same moment both count', async () => {
		const dir = directory();
		const a = new UsageStore(dir);
		const b = new UsageStore(dir);
		await Promise.all([a.load(), b.load()]);
		await Promise.all([a.add(MODEL, { input: 100, output: 10 }, 0.4), b.add(MODEL, { input: 200, output: 20 }, 0.6)]);
		const seen = new UsageStore(dir);
		await seen.load();
		assert.equal(seen.today().requests, 2);
		assert.equal(seen.today().input, 300);
		assert.equal(seen.today().cost, 1);
		assert.deepEqual(fs.readdirSync(dir), ['usage.json'], 'the lock is gone');
	});

	test('many additions from several windows: none is lost', async () => {
		const dir = directory();
		const windows = [new UsageStore(dir), new UsageStore(dir), new UsageStore(dir)];
		await Promise.all(Array.from({ length: 30 }, (_, i) => windows[i % 3].add(MODEL, { input: 1, output: 1 }, 0.01)));
		const seen = new UsageStore(dir);
		await seen.load();
		assert.equal(seen.today().requests, 30);
		assert.equal(seen.month().requests, 30);
		assert.equal(Math.round(seen.today().cost * 100), 30);
	});

	test('the daily limit another window reached shows once the file is read again', async () => {
		const dir = directory();
		const a = new UsageStore(dir);
		const b = new UsageStore(dir);
		await Promise.all([a.load(), b.load()]);
		await a.add(MODEL, { input: 100, output: 10 }, 1);
		assert.equal(a.overLimit(1), true);
		assert.equal(b.overLimit(1), false, 'what this window last saw');
		await b.load();
		assert.equal(b.overLimit(1), true);
		assert.equal(b.overLimit(0), false, '0 is no limit');
	});

	test('a lock left behind by a window that died is taken over', async () => {
		const dir = directory();
		fs.mkdirSync(dir, { recursive: true });
		const lock = path.join(dir, 'usage.lock');
		fs.writeFileSync(lock, '');
		const longAgo = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, longAgo, longAgo);
		const store = new UsageStore(dir);
		await store.add(MODEL, { input: 1, output: 1 }, 0.01);
		assert.equal(store.today().requests, 1);
		assert.deepEqual(fs.readdirSync(dir), ['usage.json']);
	});

	test('a window that slept while holding the lock (a closed lid) does not write over what the others added meanwhile', async () => {
		const dir = directory();
		const lock = path.join(dir, 'usage.lock');
		const a = new UsageStore(dir);
		const b = new UsageStore(dir);
		// A takes the lock, reads the (empty) ledger, and is put to sleep.
		const sleeping = pauseAfterReading(a);
		const first = a.add(MODEL, { input: 100, output: 10 }, 0.4);
		await sleeping.paused;
		const longAgo = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, longAgo, longAgo);
		// B finds the lock stale, takes it over, and is itself still at work when A wakes up.
		const working = pauseAfterReading(b);
		const second = b.add(MODEL, { input: 200, output: 20 }, 0.6);
		await working.paused;
		const held = fs.readFileSync(lock, 'utf8');
		sleeping.resume();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(fs.readFileSync(lock, 'utf8'), held, 'A does not remove the lock B holds');
		assert.equal(fs.existsSync(path.join(dir, 'usage.json')), false, 'A does not write what it read before it slept');
		working.resume();
		await Promise.all([first, second]);
		const seen = new UsageStore(dir);
		await seen.load();
		assert.equal(seen.today().requests, 2);
		assert.equal(seen.today().input, 300);
		assert.equal(seen.today().cost, 1);
		assert.equal(a.today().requests, 2, 'A counted its request once, on top of B\'s');
		assert.deepEqual(fs.readdirSync(dir), ['usage.json']);
	});

	test('listeners hear of additions and of reading again', async () => {
		const store = new UsageStore(directory());
		let heard = 0;
		const subscription = store.onDidChange(() => heard++);
		await store.add(MODEL, {}, undefined);
		await store.load();
		subscription.dispose();
		await store.load();
		assert.equal(heard, 2);
		assert.equal(store.today().unknown, 1);
	});
});
