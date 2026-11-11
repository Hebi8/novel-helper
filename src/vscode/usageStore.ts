// The usage totals, kept in a file in the extension's global storage so that
// every window on this machine adds to the same numbers.

import * as vscode from 'vscode';
import { dayKey, type Ledger, overDailyLimit, prune, record, sum, totalsFor, type Totals, type Usage } from '../core/usage';

export class UsageStore implements vscode.Disposable {
	private readonly file: vscode.Uri;
	private readonly changed = new vscode.EventEmitter<void>();
	/** The ledger as of the last read or write in this window. */
	private ledger: Ledger = {};
	private queue: Promise<void> = Promise.resolve();

	/** Fires after the totals change in this window. */
	readonly onDidChange = this.changed.event;

	constructor(private readonly directory: vscode.Uri) {
		this.file = vscode.Uri.joinPath(directory, 'usage.json');
	}

	private async read(): Promise<void> {
		try {
			this.ledger = JSON.parse(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.file))) as Ledger;
		} catch {
			// No file yet: keep what this window has.
		}
	}

	/** Reads the file again: other windows may have added to it. */
	async load(): Promise<Ledger> {
		await this.read();
		this.changed.fire();
		return this.ledger;
	}

	/**
	 * Adds one request to the totals on disk, on top of what other windows
	 * have written since. `cost` is undefined when the price is not known.
	 */
	add(model: string, usage: Usage, cost: number | undefined): Promise<void> {
		const write = async () => {
			const now = new Date();
			await this.read();
			record(this.ledger, dayKey(now), model, usage, cost);
			prune(this.ledger, now);
			this.changed.fire();
			await vscode.workspace.fs.createDirectory(this.directory);
			await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(JSON.stringify(this.ledger)));
		};
		// One at a time; a write that failed does not hold up the next.
		this.queue = this.queue.then(write, write);
		return this.queue;
	}

	/** The totals as this window last saw them. */
	current(): Ledger {
		return this.ledger;
	}

	/** Today's totals as this window last saw them. */
	today(): Totals {
		return sum(totalsFor(this.ledger, dayKey(new Date())));
	}

	/** Whether today's estimated cost has reached `limit` dollars; 0 is no limit. */
	overLimit(limit: number): boolean {
		return overDailyLimit(this.ledger, dayKey(new Date()), limit);
	}

	dispose(): void {
		this.changed.dispose();
	}
}
