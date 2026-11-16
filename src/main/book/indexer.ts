import { movedPath } from '../../shared/paths';
import { dirname } from 'node:path';
import { conflictCandidate, findConflictCopies, type ConflictCopy } from '../../core/conflict';
import { comparePaths } from '../../core/naturalSort';
import { buildOutline, type OutlineGraph } from '../../core/outline';
import { readdir, stat, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, basename, matchesGlob } from 'node:path';
import { Library, globRootDepth, globFolders, type FileKind, type Rename } from '../../core/library';
import { MARKER_FILE, SCAN_DEPTH, SCAN_EXCLUDE, parseMarker, type Marker, storiesFromMarkers } from '../../core/story';
import { defaults, type Settings } from '../../shared/defaults';
import type { Book, DiskFile, SaveResult } from '../../shared/api';
import {
	atomicWrite,
	currentICloudRoot,
	isBookInICloud,
	isDiskConflictCopy,
	readAuxiliaryOptional,
	readOptional,
	readDocument,
	FileFormatError,
	type LineEnding,
} from './files';
const groupsFor = (settings: Settings) =>
	[
		['lore', settings['files.lore']],
		['chapter', settings['files.chapters']],
		['outline', settings['files.outlines']],
		['summary', settings['files.summaries']],
	] as const;

function ignored(error: unknown): boolean {
	return ['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
}
async function children(directory: string) {
	try {
		return await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (ignored(error)) {
			return [];
		}
		throw error;
	}
}
function visiblePath(path: string): boolean {
	return path.split('/').every((segment) => !segment.startsWith('.'));
}
function proseFile(path: string): boolean {
	return visiblePath(path) && /\.(md|txt)$/.test(path);
}
export async function scanFiles(root: string, relative: string): Promise<string[]> {
	const entries = await children(join(root, relative));
	return (
		await Promise.all(
			entries
				.filter((entry) => visiblePath(`${relative}/${entry.name}`))
				.map(async (entry) => {
					const path = relative ? `${relative}/${entry.name}` : entry.name;
					return entry.isDirectory() ? scanFiles(root, path) : entry.isFile() && proseFile(path) ? [path] : [];
				}),
		)
	).flat();
}
export async function findStories(root: string, icloudRoot = currentICloudRoot()): Promise<string[]> {
	const markers: string[] = [];
	async function visit(relative: string, depth: number): Promise<void> {
		const marker = relative ? `${relative}/${MARKER_FILE}` : MARKER_FILE;
		try {
			const text = await readAuxiliaryOptional(root, marker, isBookInICloud(join(root, relative), icloudRoot));
			if (text !== undefined && parseMarker(text)) {
				markers.push(marker);
			}
		} catch (error) {
			if (!ignored(error) && !(error instanceof FileFormatError)) {
				throw error;
			}
		}
		if (depth === SCAN_DEPTH) {
			return;
		}
		const entries = await children(join(root, relative));
		await Promise.all(
			entries
				.filter(
					(entry) => entry.isDirectory() && !entry.name.startsWith('.') && !matchesGlob(`${relative}/${entry.name}/file`, SCAN_EXCLUDE),
				)
				.map((entry) => visit(relative ? `${relative}/${entry.name}` : entry.name, depth + 1)),
		);
	}
	await visit('', 0);
	return storiesFromMarkers(markers)
		.slice(0, 50)
		.map((path) => join(root, path));
}
export class BookIndex {
	library = new Library(defaults['files.bookNames']);
	private settings: Settings = defaults;
	get configuration(): Settings {
		return this.settings;
	}
	private get groups() {
		return groupsFor(this.settings);
	}
	private get roots() {
		return [...new Set(this.groups.flatMap(([, patterns]) => patterns.flatMap(globFolders)))];
	}
	private referenceVersion = 0;
	private buoyVersion = 0;
	private referenceContents = new Map<string, string | undefined>();
	private unreadableOutlines = new Set<string>();
	private graph?: { key: string; value: OutlineGraph & { unreadable: string[] } };
	private files = new Set<string>();
	private conflicts = new Map<string, string>();
	private contents = new Map<string, string>();
	private lineEndings = new Map<string, LineEnding>();
	private opened = new Set<string>();
	private pending = new Set<string>();
	private watcher?: FSWatcher;
	private queue: Promise<void> = Promise.resolve();
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	marker?: Marker;
	private readonly changedListeners = new Set<(book: Book) => void>();
	private readonly fileListeners = new Set<(file: DiskFile) => void>();
	onChanged(listener: (book: Book) => void): () => void {
		this.changedListeners.add(listener);
		return () => {
			this.changedListeners.delete(listener);
		};
	}
	onFileChanged(listener: (file: DiskFile) => void): () => void {
		this.fileListeners.add(listener);
		return () => {
			this.fileListeners.delete(listener);
		};
	}
	private fileChanged(file: DiskFile): void {
		this.fileListeners.forEach((listener) => listener(file));
	}
	readonly inICloud: boolean;
	constructor(
		readonly root: string,
		settings: Settings = defaults,
		icloudRoot = currentICloudRoot(),
	) {
		this.settings = settings;
		this.inICloud = isBookInICloud(root, icloudRoot);
		this.library = new Library(settings['files.bookNames']);
	}
	async load(): Promise<void> {
		try {
			const marker = await readAuxiliaryOptional(this.root, MARKER_FILE, this.inICloud);
			const metadata = marker !== undefined ? parseMarker(marker) : undefined;
			this.marker = metadata;
			if (metadata?.book && this.library.empty) {
				this.library = new Library([...new Set([metadata.book, ...this.settings['files.bookNames']])]);
			}
		} catch (error) {
			if (!ignored(error) && !(error instanceof FileFormatError)) {
				throw error;
			}
		}
		const paths = (await Promise.all(this.roots.map((root) => scanFiles(this.root, root)))).flat();
		paths.forEach((path) => this.files.add(path));
		this.syncConflicts();
		await Promise.all(paths.map((path) => this.updateFile(path, false)));
	}
	conflictOriginalOf(path: string): string | undefined {
		return this.conflicts.get(path);
	}
	private conflictList(): ConflictCopy[] {
		const outlines = new Set(this.library.outlines().files.map((file) => file.path));
		const rank = (original: string) =>
			this.library.isChapter(original) ? 0 : outlines.has(original) ? 1 : this.library.entry(original) ? 2 : 3;
		return [...this.conflicts.entries()]
			.map(([path, original]) => ({ path, original }))
			.sort((a, b) => rank(a.original) - rank(b.original) || comparePaths(a.path, b.path));
	}
	get book(): Book {
		return {
			root: this.root,
			name: basename(this.root),
			tree: this.library.tree(),
			conflicts: this.conflictList(),
			referenceVersion: this.referenceVersion,
			buoyVersion: this.buoyVersion,
		};
	}
	followRenames(renames: Rename[]): void {
		this.opened = new Set([...this.opened].map((path) => movedPath(path, renames)));
	}
	start(): void {
		this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
			if (!filename) {
				return;
			}
			const path = filename.toString();
			if (path.startsWith('.novel-helper/buoys/')) {
				if (conflictCandidate(path, this.inICloud, ['.json']) === undefined) {
					this.buoyVersion++;
					this.notify();
				} else {
					void isDiskConflictCopy(this.root, path, this.inICloud)
						.then((conflict) => {
							if (!conflict && !this.disposed) {
								this.buoyVersion++;
								this.notify();
							}
						})
						.catch(() => {});
				}
				return;
			}
			if (!this.roots.some((root) => path === root || path.startsWith(root + '/')) && !this.opened.has(path)) {
				return;
			}
			if (!visiblePath(path)) {
				return;
			}
			this.pending.add(path);
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				const paths = [...this.pending];
				this.pending.clear();
				void this.enqueue(async () => {
					for (const path of paths) {
						await this.refreshPath(path);
					}
					if (!this.disposed) {
						const book = this.book;
						this.changedListeners.forEach((listener) => listener(book));
					}
				});
			}, 60);
		});
	}
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async read(path: string): Promise<DiskFile> {
		const content = await readDocument(join(this.root, path));
		this.opened.add(path);
		if (content) {
			this.lineEndings.set(path, content.lineEnding);
			this.contents.set(path, content.text);
		}
		return { path, text: content?.text ?? '' };
	}
	save(path: string, text: string, base: string, force = false): Promise<SaveResult> {
		return this.enqueue(async () => {
			const disk = await readDocument(join(this.root, path));
			if (!force && disk?.text !== base) {
				return { saved: false, disk: disk?.text ?? '' };
			}
			const ending = disk?.lineEnding ?? this.lineEndings.get(path) ?? '\n';
			await atomicWrite(join(this.root, path), text.replaceAll('\n', ending));
			this.lineEndings.set(path, ending);
			this.contents.set(path, text);
			this.add(path, text);
			this.notify();
			return { saved: true };
		});
	}
	private indexFile(path: string, text?: string): void {
		for (const [kind, patterns] of this.groups) {
			for (const pattern of patterns) {
				if (!matchesGlob(path, pattern)) {
					continue;
				}
				if ((kind === 'lore' || kind === 'outline') && (!this.referenceContents.has(path) || this.referenceContents.get(path) !== text)) {
					this.referenceContents.set(path, text);
					this.referenceVersion++;
				}
				if (kind === 'lore') {
					if (text !== undefined) {
						this.library.setLore(path, text);
					}
				} else {
					this.library.addFile(kind as FileKind, path, globRootDepth(pattern));
				}
			}
		}
	}
	private unindexFile(path: string): void {
		if (this.referenceContents.delete(path)) {
			this.referenceVersion++;
		}
		this.library.deleteLore(path);
		for (const kind of ['chapter', 'outline', 'summary'] as const) {
			this.library.deleteFile(kind, path);
		}
	}
	private syncConflicts(): void {
		const next = new Map(findConflictCopies(this.files, this.inICloud).map((item) => [item.path, item.original]));
		for (const previous of [...this.conflicts.keys()]) {
			if (!next.has(previous)) {
				this.conflicts.delete(previous);
				if (this.files.has(previous)) {
					this.indexFile(previous, this.contents.get(previous));
				}
			}
		}
		for (const [copy, original] of next) {
			if (!this.conflicts.has(copy)) {
				this.unindexFile(copy);
			}
			this.conflicts.set(copy, original);
		}
	}
	private add(path: string, text?: string): void {
		const added = !this.files.has(path);
		this.files.add(path);
		if (added) {
			this.syncConflicts();
		}
		if (!this.conflicts.has(path)) {
			this.indexFile(path, text);
		}
	}
	private remove(path: string): void {
		this.files.delete(path);
		this.unindexFile(path);
		this.contents.delete(path);
		this.syncConflicts();
	}
	private async updateFile(path: string, notify: boolean): Promise<void> {
		let content;
		try {
			content = await readDocument(join(this.root, path));
		} catch (error) {
			if (error instanceof FileFormatError || ignored(error)) {
				this.library.deleteLore(path);
				this.contents.delete(path);
				this.add(path);
				if (notify && this.opened.has(path)) {
					this.fileChanged({ path, text: '', error: String(error) });
				}
				return;
			}
			throw error;
		}
		if (this.disposed) {
			return;
		}
		const previous = this.contents.get(path);
		const tracked = this.files.has(path) || this.contents.has(path) || this.opened.has(path);
		if (!content) {
			this.remove(path);
			if (notify && tracked) {
				this.fileChanged({ path, text: '' });
			}
			return;
		}
		this.lineEndings.set(path, content.lineEnding);
		this.contents.set(path, content.text);
		this.add(path, content.text);
		if (notify && tracked && previous !== content.text) {
			this.fileChanged({ path, text: content.text });
		}
	}
	private async refreshPath(path: string): Promise<void> {
		const info = await stat(join(this.root, path)).catch((error) => {
			if (ignored(error)) {
				return undefined;
			}
			throw error;
		});
		if (info?.isDirectory()) {
			const paths = await scanFiles(this.root, path);
			const existing = new Set(paths);
			for (const prior of this.files) {
				if (prior.startsWith(path + '/') && !existing.has(prior)) {
					await this.updateFile(prior, true);
				}
			}
			for (const file of paths) {
				await this.updateFile(file, true);
			}
		} else if (proseFile(path) && (info?.isFile() || !info)) {
			await this.updateFile(path, true);
		} else {
			const known = new Set([...this.files, ...this.opened]);
			for (const file of known) {
				if (file.startsWith(path + '/')) {
					await this.updateFile(file, true);
				}
			}
		}
	}

	notify(): void {
		if (!this.disposed) {
			this.changedListeners.forEach((listener) => listener(this.book));
		}
	}
	async outlineSource(path: string): Promise<{ path: string; content: string } | undefined> {
		try {
			const content = await readDocument(join(this.root, path));
			this.unreadableOutlines.delete(path);
			return content && { path, content: content.text };
		} catch (error) {
			if (error instanceof FileFormatError || ignored(error)) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					this.unreadableOutlines.delete(path);
				} else {
					this.unreadableOutlines.add(path);
				}
				return undefined;
			}
			throw error;
		}
	}
	async outline(): Promise<OutlineGraph & { unreadable: string[] }> {
		const { files, book } = this.library.outlines();
		const sources = await Promise.all(
			files.map(async (file) => {
				const source = await this.outlineSource(file.path);
				return source && { ...file, content: source.content };
			}),
		);
		const unreadable = files.filter((file) => this.unreadableOutlines.has(file.path)).map((file) => file.path);
		const key = JSON.stringify([sources, book, unreadable]);
		if (this.graph?.key !== key) {
			this.graph = {
				key,
				value: {
					...buildOutline(
						sources.filter((file) => file !== undefined),
						{ file: book.outline, name: book.name },
					),
					unreadable,
				},
			};
		}
		return this.graph!.value;
	}
	async refresh(path: string): Promise<void> {
		await this.enqueue(() => this.updateFile(path, true));
		this.notify();
	}
	mutate(path: string, change: (raw: string | undefined) => string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const full = join(this.root, path);
			const before = await readOptional(full);
			const after = change(before);
			if (after === undefined) {
				return;
			}
			await mkdir(dirname(full), { recursive: true });
			await atomicWrite(full, after);
			await this.updateFile(path, true);
			this.notify();
		});
	}
	async reconfigure(settings: Settings): Promise<void> {
		await this.exclusive(async () => {
			this.settings = settings;
		});
	}
	/** Serialize structural changes with saves and suspend watcher notifications, including on failure. */
	exclusive<T>(operation: () => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const watching = !!this.watcher;
			this.watcher?.close();
			this.watcher = undefined;
			clearTimeout(this.timer);
			this.pending.clear();
			try {
				return await operation();
			} finally {
				this.library = new Library(this.settings['files.bookNames']);
				this.files.clear();
				this.conflicts.clear();
				this.contents.clear();
				this.lineEndings.clear();
				this.referenceContents.clear();
				this.referenceVersion++;
				this.buoyVersion++;
				this.graph = undefined;
				try {
					await this.load();
					this.notify();
				} finally {
					if (watching) {
						this.start();
					}
				}
			}
		});
	}
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.watcher?.close();
		this.changedListeners.clear();
		this.fileListeners.clear();
	}
}
