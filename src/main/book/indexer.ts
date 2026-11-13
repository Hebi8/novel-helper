import { readdir, realpath, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, basename, matchesGlob } from 'node:path';
import { Library, globRootDepth, globFolders, type FileKind } from '../../core/library';
import { MARKER_FILE, SCAN_DEPTH, SCAN_EXCLUDE, parseMarker, storyState, storiesFromMarkers, isUsable } from '../../core/story';
import { defaults } from '../../shared/defaults';
import type { Book, DiskFile, SaveResult } from '../../shared/api';
import { atomicWrite, readOptional, readDocument, FileFormatError, type LineEnding } from './files';
const groups = [
	['lore', defaults['files.lore']],
	['chapter', defaults['files.chapters']],
	['outline', defaults['files.outlines']],
	['summary', defaults['files.summaries']],
] as const;
const roots = [...new Set(groups.flatMap(([, patterns]) => patterns.flatMap(globFolders)))];
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
export async function scanFiles(root: string, relative: string): Promise<string[]> {
	const entries = await children(join(root, relative));
	return (
		await Promise.all(
			entries
				.filter((entry) => !entry.name.startsWith('.'))
				.map(async (entry) => {
					const path = `${relative}/${entry.name}`;
					return entry.isDirectory() ? scanFiles(root, path) : entry.isFile() && /\.(md|txt)$/.test(entry.name) ? [path] : [];
				}),
		)
	).flat();
}
export async function findStories(root: string): Promise<string[]> {
	const markers: string[] = [];
	async function visit(relative: string, depth: number): Promise<void> {
		const marker = relative ? `${relative}/${MARKER_FILE}` : MARKER_FILE;
		try {
			const text = await readOptional(join(root, marker));
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
	readonly library = new Library(defaults['files.bookNames']);
	private contents = new Map<string, string>();
	private lineEndings = new Map<string, LineEnding>();
	private opened = new Set<string>();
	private pending = new Set<string>();
	private watcher?: FSWatcher;
	private queue: Promise<void> = Promise.resolve();
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private marked = false;
	onChanged: (book: Book) => void = () => {};
	onFileChanged: (file: DiskFile) => void = () => {};
	constructor(readonly root: string) {}
	async load(): Promise<void> {
		try {
			const marker = await readOptional(join(this.root, MARKER_FILE));
			this.marked = marker !== undefined && parseMarker(marker) !== undefined;
		} catch (error) {
			if (!ignored(error) && !(error instanceof FileFormatError)) {
				throw error;
			}
		}
		const paths = (await Promise.all(roots.map((root) => scanFiles(this.root, root)))).flat();
		await Promise.all(paths.map((path) => this.updateFile(path, false)));
	}
	get book(): Book {
		return { root: this.root, name: basename(this.root), tree: this.library.tree() };
	}
	async usable(): Promise<boolean> {
		return isUsable(storyState({ valid: true, exists: true, marked: this.marked, hasFiles: !this.library.empty }));
	}
	start(): void {
		this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
			if (!filename) {
				return;
			}
			const path = filename.toString();
			if (!roots.some((root) => path === root || path.startsWith(root + '/')) && !this.opened.has(path)) {
				return;
			}
			if (path.endsWith('.tmp')) {
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
						this.onChanged(this.book);
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
			return { saved: true };
		});
	}
	private add(path: string, text: string): void {
		for (const [kind, patterns] of groups) {
			for (const pattern of patterns) {
				if (!matchesGlob(path, pattern)) {
					continue;
				}
				if (kind === 'lore') {
					this.library.setLore(path, text);
				} else {
					this.library.addFile(kind as FileKind, path, globRootDepth(pattern));
				}
			}
		}
	}
	private remove(path: string): void {
		this.library.deleteLore(path);
		for (const kind of ['chapter', 'outline', 'summary'] as const) {
			this.library.deleteFile(kind, path);
		}
		this.contents.delete(path);
	}
	private async updateFile(path: string, notify: boolean): Promise<void> {
		let content;
		try {
			content = await readDocument(join(this.root, path));
		} catch (error) {
			if (error instanceof FileFormatError || ignored(error)) {
				this.remove(path);
				if (notify && this.opened.has(path)) {
					this.onFileChanged({ path, text: '', error: String(error) });
				}
				return;
			}
			throw error;
		}
		if (this.disposed) {
			return;
		}
		const previous = this.contents.get(path);
		const tracked = this.contents.has(path) || this.opened.has(path);
		if (!content) {
			this.remove(path);
			if (notify && tracked) {
				this.onFileChanged({ path, text: '' });
			}
			return;
		}
		this.lineEndings.set(path, content.lineEnding);
		this.contents.set(path, content.text);
		this.add(path, content.text);
		if (notify && tracked && previous !== content.text) {
			this.onFileChanged({ path, text: content.text });
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
			for (const prior of this.contents.keys()) {
				if (prior.startsWith(path + '/') && !existing.has(prior)) {
					await this.updateFile(prior, true);
				}
			}
			for (const file of paths) {
				await this.updateFile(file, true);
			}
		} else if (info?.isFile() || /\.(md|txt)$/.test(path)) {
			await this.updateFile(path, true);
		} else {
			const known = new Set([...this.contents.keys(), ...this.opened]);
			for (const file of known) {
				if (file.startsWith(path + '/')) {
					await this.updateFile(file, true);
				}
			}
		}
	}
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.watcher?.close();
	}
}
export async function inspectBook(root: string): Promise<{ index?: BookIndex; roots: string[] }> {
	const canonical = await realpath(root);
	const index = new BookIndex(canonical);
	await index.load();
	if (await index.usable()) {
		return { index, roots: [] };
	}
	index.dispose();
	return { roots: await findStories(canonical) };
}
