// The usage totals, kept in a file in the extension's global storage so that
// every window on this machine adds to the same numbers.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dayKey, type Ledger, overDailyLimit, prune, record, sum, totalsFor, type Totals, type Usage } from '../core/usage';

/** A lock this old is taken over: adding to the file takes milliseconds, so its holder died or was put to sleep. */
const STALE_LOCK_MS = 5000;
const LOCK_RETRY_MS = 20;

export class UsageStore {
	private readonly file: string;
	private readonly lock: string;
	private readonly listeners = new Set<() => void>();
	/** The ledger as of the last read or write in this window. */
	private ledger: Ledger = {};

	constructor(private readonly directory: string) {
		this.file = path.join(directory, 'usage.json');
		this.lock = path.join(directory, 'usage.lock');
	}

	/** Calls `listener` after the totals this window knows of change. */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** The ledger on disk; undefined when there is no file yet. */
	private async read(): Promise<Ledger | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.file, 'utf8')) as Ledger;
		} catch {
			return undefined;
		}
	}

	/**
	 * Takes the lock file, which only one window (of any VS Code process)
	 * can create at a time, and returns what this holder wrote into it. A
	 * lock older than `STALE_LOCK_MS` is taken over: its holder died, or was
	 * asleep that long (a closed laptop lid) and will find out in `holds`.
	 */
	private async acquire(): Promise<string> {
		const id = randomUUID();
		await fs.mkdir(this.directory, { recursive: true });
		for (;;) {
			try {
				await fs.writeFile(this.lock, id, { flag: 'wx' });
				return id;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
			}
			const held = await fs.stat(this.lock).catch(() => undefined);
			if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
				await fs.rm(this.lock, { force: true });
			} else {
				await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
			}
		}
	}

	/** Whether the lock is still the one this holder took: not taken over in the meantime. */
	private async holds(id: string): Promise<boolean> {
		return (await fs.readFile(this.lock, 'utf8').catch(() => undefined)) === id;
	}

	/** Gives the lock back, if it is still this holder's: a lock someone else took over is theirs to remove. */
	private async release(id: string): Promise<void> {
		if (await this.holds(id)) {
			await fs.rm(this.lock, { force: true });
		}
	}

	/** Reads the file again: other windows may have added to it. Waits for an addition that is being written. */
	async load(): Promise<Ledger> {
		const id = await this.acquire();
		try {
			this.ledger = (await this.read()) ?? this.ledger;
		} finally {
			await this.release(id);
		}
		this.listeners.forEach((listener) => listener());
		return this.ledger;
	}

	/**
	 * Adds one request to the totals on disk, on top of what other windows
	 * have written: reading, adding and writing happen under the lock, so two
	 * windows adding at once both count. If the lock was taken over while
	 * this window held it, what it read may be out of date: it starts over
	 * instead of writing. `cost` is undefined when the price is not known.
	 */
	async add(model: string, usage: Usage, cost: number | undefined): Promise<void> {
		for (let written = false; !written; ) {
			const id = await this.acquire();
			try {
				const now = new Date();
				const ledger = (await this.read()) ?? structuredClone(this.ledger);
				record(ledger, dayKey(now), model, usage, cost);
				prune(ledger, now);
				if (await this.holds(id)) {
					await fs.writeFile(this.file, JSON.stringify(ledger));
					this.ledger = ledger;
					written = true;
				}
			} finally {
				await this.release(id);
			}
		}
		this.listeners.forEach((listener) => listener());
	}

	/** The totals as this window last saw them. */
	current(): Ledger {
		return this.ledger;
	}

	/** Today's totals as this window last saw them. */
	today(): Totals {
		return sum(totalsFor(this.ledger, dayKey(new Date())));
	}

	/** This month's totals as this window last saw them. */
	month(): Totals {
		return sum(totalsFor(this.ledger, dayKey(new Date()).slice(0, 7)));
	}

	/**
	 * Whether today's estimated cost has reached `limit` dollars, going by
	 * what this window last saw; 0 is no limit. Other windows may have spent
	 * more since: `load()` first where that matters.
	 */
	overLimit(limit: number): boolean {
		return overDailyLimit(this.ledger, dayKey(new Date()), limit);
	}
}
