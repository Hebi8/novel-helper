import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hourBucketKey, pruneWordHours, sumDayWords } from '../core/words';

interface StoredBookWords {
	book: string;
	total: number;
	hours: Record<string, number>;
}

function canonicalRoot(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return root;
	}
}

function bookId(realRoot: string): string {
	return createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
}

export class WordCountStore {
	private readonly entries = new Map<string, StoredBookWords>();

	constructor(
		private readonly directory: string,
		private readonly now: () => Date = () => new Date(),
	) {
		mkdirSync(directory, { recursive: true });
	}

	private fileFor(realRoot: string): string {
		return join(this.directory, `${bookId(realRoot)}.json`);
	}

	private loadEntry(realRoot: string, fallbackTotal: number): StoredBookWords {
		const cached = this.entries.get(realRoot);
		if (cached) {
			return cached;
		}
		const file = this.fileFor(realRoot);
		let entry: StoredBookWords;
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredBookWords>;
			entry = {
				book: realRoot,
				total: typeof parsed.total === 'number' ? parsed.total : fallbackTotal,
				hours: parsed.hours && typeof parsed.hours === 'object' ? { ...parsed.hours } : {},
			};
		} else {
			entry = { book: realRoot, total: fallbackTotal, hours: {} };
		}
		this.entries.set(realRoot, entry);
		return entry;
	}

	private saveEntry(realRoot: string, entry: StoredBookWords): void {
		const file = this.fileFor(realRoot);
		const tmp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(tmp, JSON.stringify(entry, null, 2));
		renameSync(tmp, file);
	}

	openBook(root: string, currentTotal: number): void {
		const realRoot = canonicalRoot(root);
		const entry = this.loadEntry(realRoot, currentTotal);
		entry.total = currentTotal;
		pruneWordHours(entry.hours, this.now());
		this.saveEntry(realRoot, entry);
	}

	recordTotal(root: string, nextTotal: number): void {
		const realRoot = canonicalRoot(root);
		const entry = this.loadEntry(realRoot, nextTotal);
		const delta = nextTotal - entry.total;
		if (delta === 0) {
			return;
		}
		const date = this.now();
		const bucket = hourBucketKey(date);
		entry.hours[bucket] = (entry.hours[bucket] ?? 0) + delta;
		entry.total = nextTotal;
		pruneWordHours(entry.hours, date);
		this.saveEntry(realRoot, entry);
	}

	today(root: string, startHour = 0): number {
		const realRoot = canonicalRoot(root);
		const entry = this.entries.get(realRoot);
		if (!entry) {
			const file = this.fileFor(realRoot);
			if (!existsSync(file)) {
				return 0;
			}
			const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredBookWords>;
			return sumDayWords(parsed.hours ?? {}, this.now(), startHour);
		}
		return sumDayWords(entry.hours, this.now(), startHour);
	}
}
