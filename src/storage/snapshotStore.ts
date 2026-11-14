// The snapshots of one story folder, on disk below `.novel-helper/snapshots`:
//
//   objects/ab/cdef…        the content of a file kept for assistant turns, named by its SHA-256
//   timed-objects/ab/cdef…  the content kept for timed snapshots (hard-linked with `objects` when shared)
//   turns/000012.json       a SnapshotRecord: the files right before a turn, and what the turn changed
//   timed.json              timed SnapshotRecords, kept separate so VS Code extension 0.4.0 never misreads or prunes them
//   .gitignore              `*`, so that a story kept in git does not pick the snapshots up
//   lock                    there while a window reads the folder into a snapshot or changes the records
//
// Changes are found by reading the folder again and comparing, not by
// watching what the agent says it wrote: an agent can write to disk itself.

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	afterManifest,
	type Change,
	diff,
	expired,
	looksBinary,
	type Manifest,
	MAX_FILE_BYTES,
	parseRecord,
	referenced,
	restorePlan,
	type RestorePlan,
	skipsFolder,
	SNAPSHOT_DIR,
	type SnapshotRecord,
} from '../core/snapshot';
import { FileLock } from './fileLock';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const existsError = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST';

/** Timed snapshot IDs stay disjoint from `turns/000001.json` IDs even if extension 0.4.0 adds turns. */
const TIMED_ID_START = 1_000_000_000;

/** A lock this old is taken over. Its holder touches it every `LOCK_TOUCH_MS` while it works, so one this old belongs to a window that died or was put to sleep. */
const STALE_LOCK_MS = 10_000;
const LOCK_TOUCH_MS = 2000;

/**
 * A file that going back would write, where there is now something no
 * snapshot holds: writing over it could not be gone back from.
 * - `link`: a symbolic link, or below one: the write would land wherever it points.
 * - `large`, `binary`: a file that is too large, or not text.
 * - `taken`: a folder where the file was, or a file where its folder was.
 */
export interface Blocked {
	path: string;
	why: 'link' | 'large' | 'binary' | 'taken';
}

/** An in-memory baseline of a story folder that has no snapshots on disk yet. */
export interface SnapshotSeed {
	files: Manifest;
	contents: Map<string, Buffer>;
}

const byTime = (a: SnapshotRecord, b: SnapshotRecord) => Date.parse(a.time) - Date.parse(b.time) || a.id - b.id;

export class SnapshotStore {
	private readonly dir: string;
	private readonly objects: string;
	private readonly timedObjects: string;
	private readonly turns: string;
	private readonly timedFile: string;
	private readonly lock: FileLock;

	/** `story` is the story folder; `keep` and `timedKeep` say how many assistant and timed records to keep. */
	constructor(
		readonly story: string,
		private readonly keep: () => number,
		private readonly timedKeep: () => number = () => 100,
	) {
		this.dir = path.join(story, ...SNAPSHOT_DIR.split('/'));
		this.objects = path.join(this.dir, 'objects');
		this.timedObjects = path.join(this.dir, 'timed-objects');
		this.turns = path.join(this.dir, 'turns');
		this.timedFile = path.join(this.dir, 'timed.json');
		this.lock = new FileLock(path.join(this.dir, 'lock'), STALE_LOCK_MS);
	}

	/**
	 * One piece of work on the snapshots at a time, in whatever window: two
	 * that start at once do not take the same id, and contents one has kept
	 * for a record it is about to write are not cleared away by the other.
	 * `read` looks at the folder and keeps contents; `write` changes the
	 * records. If the lock was taken over during `read` (this window was
	 * asleep), nothing is written and the work starts over.
	 */
	private async exclusive<T, R>(read: () => Promise<T>, write: (found: T) => Promise<R>): Promise<R> {
		for (;;) {
			const id = await this.lock.acquire();
			const alive = setInterval(() => void this.lock.touch(id), LOCK_TOUCH_MS);
			try {
				const found = await read();
				if (await this.lock.holds(id)) {
					return await write(found);
				}
			} finally {
				clearInterval(alive);
				await this.lock.release(id);
			}
		}
	}

	private objectFile(hash: string, dir = this.objects): string {
		if (!/^[0-9a-f]{64}$/.test(hash)) {
			throw new Error(`not a content hash: ${hash}`);
		}
		return path.join(dir, hash.slice(0, 2), hash.slice(2));
	}

	private recordFile(id: number): string {
		return path.join(this.turns, `${String(id).padStart(6, '0')}.json`);
	}

	/** Keeps a content in `dir` (sharing storage with the sibling object store via hard link when possible), and returns its hash. */
	private async put(content: Buffer, dir = this.objects): Promise<string> {
		const hash = createHash('sha256').update(content).digest('hex');
		const file = this.objectFile(hash, dir);
		if (await fs.stat(file).catch(() => undefined)) {
			return hash;
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		const sibling = this.objectFile(hash, dir === this.objects ? this.timedObjects : this.objects);
		if (await fs.stat(sibling).catch(() => undefined)) {
			const linked = await fs.link(sibling, file).then(
				() => true,
				(error) => existsError(error),
			);
			if (linked) {
				return hash;
			}
		}
		const temporary = `${file}.${randomUUID()}.tmp`;
		await fs.writeFile(temporary, content);
		await fs.rename(temporary, file);
		return hash;
	}

	private async pinTimed(hash: string, fallback?: Buffer): Promise<void> {
		const file = this.objectFile(hash, this.timedObjects);
		if (await fs.stat(file).catch(() => undefined)) {
			return;
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		const source = this.objectFile(hash, this.objects);
		const linked = await fs.link(source, file).then(
			() => true,
			(error) => existsError(error),
		);
		if (!linked) {
			const content = fallback ?? (await fs.readFile(source));
			const temporary = `${file}.${randomUUID()}.tmp`;
			await fs.writeFile(temporary, content);
			await fs.rename(temporary, file);
		}
	}

	/** The hash of a file of the story folder as it is on disk now; undefined when it is not there. */
	async hashOf(file: string): Promise<string | undefined> {
		const content = await fs.readFile(path.join(this.story, ...file.split('/'))).catch(() => undefined);
		return content && createHash('sha256').update(content).digest('hex');
	}

	/** The content kept under a hash. */
	read(hash: string): Promise<Buffer> {
		return fs
			.readFile(this.objectFile(hash, this.objects))
			.catch((error) => (missing(error) ? fs.readFile(this.objectFile(hash, this.timedObjects)) : Promise.reject(error)));
	}

	private async walk(folder: string, relative: string, visit: (child: string, content: Buffer) => Promise<void>): Promise<void> {
		for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			const full = path.join(folder, entry.name);
			if (entry.isDirectory()) {
				if (!skipsFolder(child)) {
					await this.walk(full, child, visit);
				}
			} else if (entry.isFile()) {
				// Links are neither: they are not followed. A file can go away while the folder is read (an editor's temporary file).
				try {
					if ((await fs.stat(full)).size <= MAX_FILE_BYTES) {
						const content = await fs.readFile(full);
						if (!looksBinary(content)) {
							await visit(child, content);
						}
					}
				} catch (error) {
					if (!missing(error)) {
						throw error;
					}
				}
			}
		}
	}

	/** Reads the current text files in memory without creating `.novel-helper/snapshots`. */
	async seed(): Promise<SnapshotSeed> {
		const files: Manifest = {};
		const contents = new Map<string, Buffer>();
		await this.walk(this.story, '', async (child, content) => {
			const hash = createHash('sha256').update(content).digest('hex');
			files[child] = hash;
			if (!contents.has(hash)) {
				contents.set(hash, content);
			}
		});
		return { files, contents };
	}

	/** The text files of the story folder as they are now, their contents kept. */
	capture(): Promise<Manifest> {
		return this.exclusive(
			() => this.scanAll(),
			async (manifest) => manifest,
		);
	}

	private async scanAll(dir = this.objects): Promise<Manifest> {
		await fs.mkdir(this.dir, { recursive: true });
		await fs.writeFile(path.join(this.dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
		const manifest: Manifest = {};
		await this.walk(this.story, '', async (child, content) => {
			manifest[child] = await this.put(content, dir);
		});
		return manifest;
	}

	private async listTurns(): Promise<SnapshotRecord[]> {
		const names = await fs.readdir(this.turns).catch(() => [] as string[]);
		const records = await Promise.all(
			names.filter((name) => name.endsWith('.json')).map(async (name) => parseRecord(await fs.readFile(path.join(this.turns, name), 'utf8'))),
		);
		return records.filter((record): record is SnapshotRecord => record !== undefined).sort((a, b) => a.id - b.id);
	}

	private async listTimed(): Promise<SnapshotRecord[]> {
		const text = await fs.readFile(this.timedFile, 'utf8').catch(() => '');
		if (!text) {
			return [];
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return [];
		}
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed
			.map((item) => parseRecord(JSON.stringify(item)))
			.filter((record): record is SnapshotRecord => record?.kind === 'timed')
			.sort((a, b) => a.id - b.id);
	}

	/** Every record that can be read, oldest first. */
	async list(): Promise<SnapshotRecord[]> {
		const [turns, timed] = await Promise.all([this.listTurns(), this.listTimed()]);
		return [...turns, ...timed].sort(byTime);
	}

	async get(id: number): Promise<SnapshotRecord | undefined> {
		const turn = parseRecord(await fs.readFile(this.recordFile(id), 'utf8').catch(() => ''));
		return turn ?? (await this.listTimed()).find((record) => record.id === id);
	}

	/** Written under another name first and then put in place: a window that dies while writing leaves the record as it was, not cut short. */
	private async write(record: SnapshotRecord): Promise<void> {
		await fs.mkdir(this.turns, { recursive: true });
		const file = this.recordFile(record.id);
		const temporary = `${file}.${randomUUID()}.tmp`;
		await fs.writeFile(temporary, JSON.stringify(record));
		await fs.rename(temporary, file);
	}

	private async writeTimed(records: SnapshotRecord[]): Promise<void> {
		if (!records.length) {
			await fs.rm(this.timedFile, { force: true });
			return;
		}
		await fs.mkdir(this.dir, { recursive: true });
		const temporary = `${this.timedFile}.${randomUUID()}.tmp`;
		await fs.writeFile(temporary, JSON.stringify(records));
		await fs.rename(temporary, this.timedFile);
	}

	private nextTime(existing: readonly SnapshotRecord[], now = Date.now()): string {
		const latest = existing.reduce((max, record) => Math.max(max, Date.parse(record.time) || 0), 0);
		return new Date(Math.max(now, latest + 1)).toISOString();
	}

	/** Takes the snapshot that a turn, or a going back, starts from. */
	begin(about: Pick<SnapshotRecord, 'kind' | 'title' | 'target'>): Promise<SnapshotRecord> {
		return this.exclusive(
			() => this.scanAll(),
			async (files) => {
				const [turns, timed] = await Promise.all([this.listTurns(), this.listTimed()]);
				const last = turns.at(-1)?.id ?? 0;
				const record: SnapshotRecord = { id: last + 1, time: this.nextTime([...turns, ...timed]), ...about, files };
				await this.write(record);
				return record;
			},
		);
	}

	/**
	 * Keeps a timed checkpoint of the whole story folder when anything changed
	 * since the latest snapshot (or `baseline` when the book had none yet).
	 */
	async timed(baseline?: SnapshotSeed, now?: number): Promise<SnapshotRecord | undefined> {
		if (baseline && !(await fs.stat(this.dir).catch(() => undefined))) {
			const current = await this.seed();
			if (!diff(baseline.files, current.files).length) {
				return undefined;
			}
		}
		return this.exclusive(
			() => this.scanAll(this.timedObjects),
			async (files) => {
				const [turns, timed] = await Promise.all([this.listTurns(), this.listTimed()]);
				const all = [...turns, ...timed].sort(byTime);
				const latest = all.at(-1);
				const previous = latest ? afterManifest(latest) : (baseline?.files ?? {});
				const changes = diff(previous, files);
				if (!changes.length) {
					await this.pruneObjects(this.timedObjects, referenced(timed));
					return undefined;
				}
				for (const change of changes) {
					if (change.before !== undefined) {
						await this.pinTimed(change.before, baseline?.contents.get(change.before));
					}
				}
				const last = timed.at(-1)?.id ?? TIMED_ID_START;
				const record: SnapshotRecord = {
					id: last + 1,
					time: this.nextTime(all, now),
					kind: 'timed',
					files,
					changes,
				};
				await this.writeTimed([...timed, record]);
				await this.prune();
				return record;
			},
		);
	}

	/**
	 * Ends what `begin` started: reads the folder again and records what
	 * changed. A record that changed nothing is dropped, there being nothing
	 * to go back from. Then the oldest records over the limit are dropped, and
	 * the contents nothing refers to any more.
	 */
	finish(id: number): Promise<Change[]> {
		return this.exclusive(
			async () => {
				const record = await this.get(id);
				return record && { record, after: await this.scanAll() };
			},
			async (found) => {
				if (!found) {
					return [];
				}
				const changes = diff(found.record.files, found.after);
				if (changes.length) {
					await this.write({ ...found.record, changes });
				} else {
					await fs.rm(this.recordFile(id), { force: true });
				}
				await this.prune();
				return changes;
			},
		);
	}

	/** What is at the place of a file of the story folder, or on the way to it, that no snapshot holds; undefined when the place is free or holds a file a snapshot would keep. */
	private async inTheWay(file: string): Promise<Blocked['why'] | undefined> {
		const parts = file.split('/');
		for (let depth = 1; depth <= parts.length; depth++) {
			const full = path.join(this.story, ...parts.slice(0, depth));
			const stat = await fs.lstat(full).catch(() => undefined);
			if (!stat) {
				return undefined;
			}
			if (stat.isSymbolicLink()) {
				return 'link';
			}
			if (depth < parts.length ? !stat.isDirectory() : !stat.isFile()) {
				return 'taken';
			}
			if (depth === parts.length) {
				return stat.size > MAX_FILE_BYTES ? 'large' : looksBinary(await fs.readFile(full)) ? 'binary' : undefined;
			}
		}
		return undefined;
	}

	/**
	 * The files of a plan that cannot be written. The scan left them out of
	 * `current`, which does not say that nothing is there: a file that grew
	 * too large or is no longer text, or a link, is left out too, and going
	 * back would write over it with nothing kept to undo that.
	 */
	private async blocked(plan: RestorePlan, current: Manifest): Promise<Blocked[]> {
		const blocked: Blocked[] = [];
		for (const { path: file } of plan.write) {
			const why = file in current ? undefined : await this.inTheWay(file);
			if (why) {
				blocked.push({ path: file, why });
			}
		}
		return blocked;
	}

	/** What going back to a record would do to the folder as it is now, and what stands in its way. */
	async preview(id: number): Promise<(RestorePlan & { blocked: Blocked[] }) | undefined> {
		const record = await this.get(id);
		if (!record) {
			return undefined;
		}
		const current = await this.capture();
		const plan = restorePlan(record.files, current);
		return { ...plan, blocked: await this.blocked(plan, current) };
	}

	/**
	 * Puts every file that changed since record `id` back as `record.files` had
	 * it: files made since are deleted, files deleted since come back. The
	 * folder as it is now is kept first, as a record of its own, so going back
	 * can be gone back from. Returns that record, if anything changed. With
	 * files in the way (`blocked`), nothing is written at all: a folder put
	 * back in part is a state the story never was in.
	 */
	async revert(id: number): Promise<{ record?: SnapshotRecord; blocked: Blocked[] }> {
		const target = await this.get(id);
		if (!target) {
			return { blocked: [] };
		}
		const record = await this.begin({ kind: 'revert', ...(target.kind !== 'timed' && { target: id }) });
		const plan = restorePlan(target.files, record.files);
		const blocked = await this.blocked(plan, record.files);
		if (!blocked.length) {
			for (const { path: file, hash } of plan.write) {
				const full = path.join(this.story, ...file.split('/'));
				await fs.mkdir(path.dirname(full), { recursive: true });
				const content = await this.read(hash);
				const temporary = `${full}.${randomUUID()}.tmp`;
				await fs.writeFile(temporary, content);
				await fs.rename(temporary, full);
			}
			for (const file of plan.remove) {
				await fs.rm(path.join(this.story, ...file.split('/')), { force: true });
			}
		}
		const changes = await this.finish(record.id);
		return { blocked, ...(changes.length && { record: { ...record, changes } }) };
	}

	private async pruneObjects(dir: string, needed: Set<string>): Promise<void> {
		for (const prefix of await fs.readdir(dir).catch(() => [] as string[])) {
			const bucket = path.join(dir, prefix);
			for (const name of await fs.readdir(bucket).catch(() => [] as string[])) {
				if (name.endsWith('.tmp') || !needed.has(prefix + name)) {
					await fs.rm(path.join(bucket, name), { force: true });
				}
			}
		}
	}

	/** Called with the lock held: nobody else is writing a record or keeping a content meanwhile. */
	private async prune(): Promise<void> {
		// What a window that died left half-written.
		for (const name of await fs.readdir(this.turns).catch(() => [] as string[])) {
			if (name.endsWith('.tmp')) {
				await fs.rm(path.join(this.turns, name), { force: true });
			}
		}
		for (const name of await fs.readdir(this.dir).catch(() => [] as string[])) {
			if (name.startsWith('timed.json.') && name.endsWith('.tmp')) {
				await fs.rm(path.join(this.dir, name), { force: true });
			}
		}
		const turns = await this.listTurns();
		const dropTurns = new Set(expired(turns.map((record) => record.id), this.keep()));
		await Promise.all([...dropTurns].map((id) => fs.rm(this.recordFile(id), { force: true })));
		await this.pruneObjects(this.objects, referenced(turns.filter((record) => !dropTurns.has(record.id))));

		const timed = await this.listTimed();
		const dropTimed = new Set(expired(timed.map((record) => record.id), this.timedKeep()));
		const keptTimed = timed.filter((record) => !dropTimed.has(record.id));
		if (dropTimed.size) {
			await this.writeTimed(keptTimed);
		}
		await this.pruneObjects(this.timedObjects, referenced(keptTimed));
	}
}
