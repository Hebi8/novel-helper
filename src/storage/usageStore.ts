// The usage totals, kept in a file in the extension's global storage so that
// every window on this machine adds to the same numbers.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dayKey, type Ledger, overDailyLimit, prune, record, sum, totalsFor, type Totals, type Usage } from '../core/usage';
import { FileLock } from './fileLock';

/** A lock this old is taken over: adding to the file takes milliseconds, so its holder died or was put to sleep. */
const STALE_LOCK_MS = 5000;

export class UsageStore {
	private readonly file: string;
	private readonly lock: FileLock;
	private readonly listeners = new Set<() => void>();
	/** The ledger as of the last read or write in this window. */
	private ledger: Ledger = {};

	constructor(private readonly directory: string) {
		this.file = path.join(directory, 'usage.json');
		this.lock = new FileLock(path.join(directory, 'usage.lock'), STALE_LOCK_MS);
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

	/** Reads the file again: other windows may have added to it. Waits for an addition that is being written. */
	async load(): Promise<Ledger> {
		const id = await this.lock.acquire();
		try {
			this.ledger = (await this.read()) ?? this.ledger;
		} finally {
			await this.lock.release(id);
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
			const id = await this.lock.acquire();
			try {
				const now = new Date();
				const ledger = (await this.read()) ?? structuredClone(this.ledger);
				record(ledger, dayKey(now), model, usage, cost);
				prune(ledger, now);
				if (await this.lock.holds(id)) {
					await fs.writeFile(this.file, JSON.stringify(ledger));
					this.ledger = ledger;
					written = true;
				}
			} finally {
				await this.lock.release(id);
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
