// A lock that windows of any VS Code process on this machine share: a file
// that only one of them can create at a time.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const RETRY_MS = 20;

export class FileLock {
	/** A lock older than `staleMs` is taken over: its holder died or was put to sleep. */
	constructor(
		private readonly file: string,
		private readonly staleMs: number,
	) {}

	/**
	 * Takes the lock, waiting for whoever has it, and returns what this
	 * holder wrote into it. A holder whose lock was taken over (it was asleep
	 * that long: a closed laptop lid) finds out in `holds`.
	 */
	async acquire(): Promise<string> {
		const id = randomUUID();
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		for (;;) {
			try {
				await fs.writeFile(this.file, id, { flag: 'wx' });
				return id;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
			}
			const held = await fs.stat(this.file).catch(() => undefined);
			if (held && Date.now() - held.mtimeMs > this.staleMs) {
				await fs.rm(this.file, { force: true });
			} else {
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			}
		}
	}

	/** Whether the lock is still the one this holder took: not taken over in the meantime. */
	async holds(id: string): Promise<boolean> {
		return (await fs.readFile(this.file, 'utf8').catch(() => undefined)) === id;
	}

	/** Says that the holder is still at work, for work that takes longer than `staleMs`. */
	async touch(id: string): Promise<void> {
		if (await this.holds(id)) {
			const now = new Date();
			await fs.utimes(this.file, now, now).catch(() => undefined);
		}
	}

	/** Gives the lock back, if it is still this holder's: a lock someone else took over is theirs to remove. */
	async release(id: string): Promise<void> {
		if (await this.holds(id)) {
			await fs.rm(this.file, { force: true });
		}
	}
}
