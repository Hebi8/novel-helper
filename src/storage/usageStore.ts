// The usage totals, kept in a file in the extension's global storage so that
// every window on this machine adds to the same numbers.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dayKey, type Ledger, overDailyLimit, prune, record, sum, totalsFor, type Totals, type Usage } from '../core/usage';

/** A lock this old was left behind by a window that died holding it; adding to the file takes milliseconds. */
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

	private async read(): Promise<void> {
		try {
			this.ledger = JSON.parse(await fs.readFile(this.file, 'utf8')) as Ledger;
		} catch {
			// No file yet: keep what this window has.
		}
	}

	/**
	 * Runs `work` while holding the lock file, which only one window (of any
	 * VS Code process) can create at a time.
	 */
	private async locked(work: () => Promise<void>): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
		for (;;) {
			try {
				await (await fs.open(this.lock, 'wx')).close();
				break;
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
		try {
			await work();
		} finally {
			await fs.rm(this.lock, { force: true });
		}
	}

	/** Reads the file again: other windows may have added to it. Waits for an addition that is being written. */
	async load(): Promise<Ledger> {
		await this.locked(() => this.read());
		this.listeners.forEach((listener) => listener());
		return this.ledger;
	}

	/**
	 * Adds one request to the totals on disk, on top of what other windows
	 * have written: reading, adding and writing happen under the lock, so two
	 * windows adding at once both count. `cost` is undefined when the price
	 * is not known.
	 */
	async add(model: string, usage: Usage, cost: number | undefined): Promise<void> {
		await this.locked(async () => {
			const now = new Date();
			await this.read();
			record(this.ledger, dayKey(now), model, usage, cost);
			prune(this.ledger, now);
			await fs.writeFile(this.file, JSON.stringify(this.ledger));
		});
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
