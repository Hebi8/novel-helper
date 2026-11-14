import type { SnapshotRecord } from '../../core/snapshot';
import { errorMessage } from '../../renderer/errors';
import { zh } from '../../renderer/strings';
import type { Settings } from '../../shared/defaults';
import { SnapshotStore, type SnapshotSeed } from '../../storage/snapshotStore';

interface OpenBook {
	generation: number;
	openedAt?: number;
	ready: boolean;
	seed?: SnapshotSeed;
}

export class BookSnapshots {
	private readonly stores = new Map<string, SnapshotStore>();
	private readonly openBooks = new Map<string, OpenBook>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly warned = new Set<string>();

	constructor(
		private readonly settings: () => Settings,
		private readonly busy: (root: string) => Promise<boolean> = async () => false,
		private readonly onError?: (root: string, message: string) => void,
	) {}

	store(root: string): SnapshotStore {
		let store = this.stores.get(root);
		if (!store) {
			store = new SnapshotStore(
				root,
				() => this.settings()['assistant.snapshots.keep'],
				() => this.settings()['snapshots.keep'],
			);
			this.stores.set(root, store);
		}
		return store;
	}

	private enqueue<T>(root: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(root) ?? Promise.resolve();
		const next = previous.then(work);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(root, settled);
		void settled.finally(() => {
			if (this.queues.get(root) === settled) {
				this.queues.delete(root);
			}
		});
		return next;
	}

	private fail(root: string, error: unknown): void {
		if (!this.warned.has(root)) {
			this.warned.add(root);
			this.onError?.(root, zh.snapshotFailed(errorMessage(error)));
		}
	}

	private async buildBaseline(root: string, entry: OpenBook, generation: number): Promise<void> {
		if (
			this.openBooks.get(root) !== entry ||
			entry.generation !== generation ||
			entry.ready ||
			this.settings()['snapshots.intervalMinutes'] <= 0
		) {
			return;
		}
		try {
			const store = this.store(root);
			const records = await store.list();
			const seed = records.length ? undefined : await store.seed();
			if (this.openBooks.get(root) !== entry || entry.generation !== generation || this.settings()['snapshots.intervalMinutes'] <= 0) {
				return;
			}
			entry.seed = seed;
			entry.ready = true;
			this.warned.delete(root);
		} catch (error) {
			this.fail(root, error);
		}
	}

	open(root: string, now = Date.now()): Promise<void> {
		this.warned.delete(root);
		const enabled = this.settings()['snapshots.intervalMinutes'] > 0;
		const entry: OpenBook = { generation: 1, openedAt: enabled ? now : undefined, ready: false };
		this.openBooks.set(root, entry);
		return enabled ? this.enqueue(root, () => this.buildBaseline(root, entry, entry.generation)) : Promise.resolve();
	}

	async reconfigure(now = Date.now()): Promise<void> {
		if (this.settings()['snapshots.intervalMinutes'] <= 0) {
			this.warned.clear();
			for (const entry of this.openBooks.values()) {
				entry.generation++;
				entry.openedAt = undefined;
				entry.ready = false;
				entry.seed = undefined;
			}
			return;
		}
		const tasks: Promise<void>[] = [];
		for (const [root, entry] of this.openBooks) {
			if (!entry.ready) {
				entry.openedAt ??= now;
				const generation = entry.generation;
				tasks.push(this.enqueue(root, () => this.buildBaseline(root, entry, generation)));
			}
		}
		await Promise.all(tasks);
	}

	beforeWrite<T = void>(root: string, work: () => Promise<T> = async () => undefined as T, now = Date.now()): Promise<T> {
		return this.enqueue(root, async () => {
			const entry = this.openBooks.get(root);
			if (entry && !entry.ready && this.settings()['snapshots.intervalMinutes'] > 0) {
				entry.openedAt ??= now;
				await this.buildBaseline(root, entry, entry.generation);
			}
			return work();
		});
	}

	schedule(root: string, now = Date.now()): void {
		void this.afterSave(root, now).catch((error) => this.fail(root, error));
	}

	write<T>(root: string, work: () => Promise<T>, shouldSchedule: (result: T) => boolean = () => true, now = Date.now()): Promise<T> {
		return this.beforeWrite(
			root,
			async () => {
				const result = await work();
				if (shouldSchedule(result)) {
					this.schedule(root, now);
				}
				return result;
			},
			now,
		);
	}

	afterSave(root: string, now = Date.now()): Promise<SnapshotRecord | undefined> {
		const entry = this.openBooks.get(root);
		return this.enqueue(root, async () => {
			const interval = this.settings()['snapshots.intervalMinutes'];
			if (!entry || !entry.ready || entry.openedAt === undefined || interval <= 0 || (await this.busy(root))) {
				return undefined;
			}
			const store = this.store(root);
			const records = await store.list();
			if (records.length) {
				entry.seed = undefined;
			}
			const reference = records.length ? Date.parse(records.at(-1)!.time) : entry.openedAt;
			if (now - reference < interval * 60_000) {
				return undefined;
			}
			const created = await store.timed(entry.seed, now);
			if (created) {
				entry.seed = undefined;
				this.warned.delete(root);
			}
			return created;
		});
	}

	close(root: string, now = Date.now(), skip?: Promise<boolean>): Promise<SnapshotRecord | undefined> {
		const entry = this.openBooks.get(root);
		this.openBooks.delete(root);
		return this.enqueue(root, async () => {
			const interval = this.settings()['snapshots.intervalMinutes'];
			const busy = await (skip ?? this.busy(root));
			if (!entry || !entry.ready || interval <= 0 || busy) {
				return undefined;
			}
			const store = this.store(root);
			const records = await store.list();
			const created = await store.timed(records.length ? undefined : entry.seed, now);
			entry.seed = undefined;
			return created;
		});
	}

	async flush(root: string): Promise<void> {
		while (this.queues.has(root)) {
			await this.queues.get(root);
		}
	}

	async drain(): Promise<void> {
		while (this.queues.size) {
			await Promise.all([...this.queues.values()]);
		}
	}
}
