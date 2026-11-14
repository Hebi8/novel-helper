import type { SnapshotRecord } from '../../core/snapshot';
import type { Settings } from '../../shared/defaults';
import { SnapshotStore, type SnapshotSeed } from '../../storage/snapshotStore';

interface OpenBookState {
	openedAt: number;
	seed?: SnapshotSeed;
}

export class BookSnapshots {
	private readonly stores = new Map<string, SnapshotStore>();
	private readonly states = new Map<string, Promise<OpenBookState>>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly closing = new Map<string, Promise<void>>();

	constructor(
		private readonly settings: () => Settings,
		private readonly busy: (root: string) => Promise<boolean> = async () => false,
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

	private ensureState(root: string, now: number): Promise<OpenBookState> {
		let pending = this.states.get(root);
		if (!pending) {
			const store = this.store(root);
			pending = (async () => {
				const records = await store.list();
				return { openedAt: now, seed: records.length ? undefined : await store.seed() };
			})();
			this.states.set(root, pending);
		}
		return pending;
	}

	open(root: string, now = Date.now()): Promise<void> {
		return this.enqueue(root, async () => {
			await this.closing.get(root);
			await this.ensureState(root, now);
		});
	}

	afterSave(root: string, now = Date.now()): Promise<SnapshotRecord | undefined> {
		return this.enqueue(root, async () => {
			const interval = this.settings()['snapshots.intervalMinutes'];
			if (interval <= 0 || (await this.busy(root))) {
				return undefined;
			}
			const state = await this.ensureState(root, now);
			const store = this.store(root);
			const records = await store.list();
			if (records.length) {
				state.seed = undefined;
			}
			const reference = records.length ? Date.parse(records.at(-1)!.time) : state.openedAt;
			if (now - reference < interval * 60_000) {
				return undefined;
			}
			const created = await store.timed(state.seed, now);
			if (created) {
				state.seed = undefined;
			}
			return created;
		});
	}

	close(root: string, now = Date.now()): Promise<SnapshotRecord | undefined> {
		const pending = this.enqueue(root, async () => {
			const state = await this.states.get(root);
			this.states.delete(root);
			const interval = this.settings()['snapshots.intervalMinutes'];
			if (interval <= 0 || (await this.busy(root))) {
				return undefined;
			}
			const store = this.store(root);
			const records = await store.list();
			return store.timed(records.length ? undefined : state?.seed, now);
		});
		const done = pending
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (this.closing.get(root) === done) {
					this.closing.delete(root);
				}
			});
		this.closing.set(root, done);
		return pending;
	}

	discard(root: string): Promise<void> {
		return this.enqueue(root, async () => {
			await this.states.get(root);
			this.states.delete(root);
		});
	}

	async flush(root: string): Promise<void> {
		await this.queues.get(root);
	}

	async drain(): Promise<void> {
		await Promise.all([...this.queues.values(), ...this.closing.values()]);
	}
}
