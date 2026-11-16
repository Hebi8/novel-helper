import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { comparePaths } from '../../core/naturalSort';
import { skipsFolder } from '../../core/snapshot';
import { zh } from '../../renderer/strings';
import { info } from '../scaffold/disk';
import { currentICloudRoot, isBookInICloud } from './files';

export const ICLOUD_DRIVE_FOLDER = 'com~apple~CloudDocs';
export const ICLOUD_BOOKS_FOLDER = 'Novel Helper';

export function icloudDriveRoot(icloudRoot = currentICloudRoot()): string {
	return join(icloudRoot, ICLOUD_DRIVE_FOLDER);
}

export function icloudBooksRoot(icloudRoot = currentICloudRoot()): string {
	return join(icloudDriveRoot(icloudRoot), ICLOUD_BOOKS_FOLDER);
}

export function isICloudDriveAvailableSync(icloudRoot = currentICloudRoot()): boolean {
	try {
		return statSync(icloudDriveRoot(icloudRoot)).isDirectory();
	} catch {
		return false;
	}
}

export async function isICloudDriveAvailable(icloudRoot = currentICloudRoot()): Promise<boolean> {
	try {
		return (await stat(icloudDriveRoot(icloudRoot))).isDirectory();
	} catch {
		return false;
	}
}

export async function listICloudBooks(icloudRoot = currentICloudRoot()): Promise<string[]> {
	if (!(await isICloudDriveAvailable(icloudRoot))) {
		return [];
	}
	const booksDir = icloudBooksRoot(icloudRoot);
	let entries;
	try {
		entries = await readdir(booksDir, { withFileTypes: true });
	} catch (error) {
		if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
			return [];
		}
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.partial'))
		.map((entry) => entry.name)
		.sort(comparePaths)
		.map((name) => join(booksDir, name));
}

export function watchICloudBooks(icloudRoot: string, onChange: (books: string[]) => void): () => void {
	let realDrive: string;
	try {
		realDrive = realpathSync(icloudDriveRoot(icloudRoot));
		if (!statSync(realDrive).isDirectory()) {
			return () => {};
		}
	} catch {
		return () => {};
	}
	const booksDir = icloudBooksRoot(icloudRoot);
	let booksWatcher: FSWatcher | undefined;
	let booksIno: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let previous: string | undefined;

	const syncBooksWatcher = () => {
		if (closed) {
			return;
		}
		let ino: number | undefined;
		let realBooks: string | undefined;
		try {
			realBooks = realpathSync(booksDir);
			const stats = statSync(realBooks);
			if (stats.isDirectory()) {
				ino = stats.ino;
			}
		} catch {
			ino = undefined;
		}
		if (ino === undefined || !realBooks) {
			booksWatcher?.close();
			booksWatcher = undefined;
			booksIno = undefined;
			return;
		}
		if (booksWatcher && booksIno === ino) {
			return;
		}
		booksWatcher?.close();
		booksIno = ino;
		booksWatcher = watch(realBooks, () => schedule());
		booksWatcher.on('error', () => {
			booksWatcher?.close();
			booksWatcher = undefined;
			booksIno = undefined;
		});
	};

	const schedule = () => {
		if (closed) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => {
			syncBooksWatcher();
			void listICloudBooks(icloudRoot).then(
				(books) => {
					if (closed) {
						return;
					}
					const serialized = JSON.stringify(books);
					if (serialized !== previous) {
						previous = serialized;
						onChange(books);
					}
				},
				() => {},
			);
		}, 50);
	};

	const driveWatcher = watch(realDrive, (_event, filename) => {
		const name = filename?.toString();
		if (!name || name === ICLOUD_BOOKS_FOLDER) {
			syncBooksWatcher();
			schedule();
		}
	});
	driveWatcher.on('error', () => {
		driveWatcher.close();
	});
	syncBooksWatcher();
	const initTimer = setTimeout(() => {
		syncBooksWatcher();
		schedule();
	}, 100);

	return () => {
		closed = true;
		clearTimeout(timer);
		clearTimeout(initTimer);
		driveWatcher.close();
		booksWatcher?.close();
	};
}

interface SourceFileStat {
	path: string;
	size: bigint;
	mtimeNs: bigint;
}

interface SourceTreeScan {
	dirs: string[];
	files: SourceFileStat[];
}

interface CopiedTreeScan {
	dirs: string[];
	files: string[];
}

async function scanSourceTree(root: string): Promise<SourceTreeScan> {
	const dirs: string[] = [];
	const files: SourceFileStat[] = [];
	async function visit(relative: string): Promise<void> {
		const dir = relative ? join(root, relative) : root;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative) {
				return;
			}
			throw error;
		}
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (skipsFolder(child)) {
				continue;
			}
			if (entry.isSymbolicLink()) {
				throw new Error(zh.renameLink);
			}
			let stats;
			try {
				stats = await lstat(join(dir, entry.name), { bigint: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					continue;
				}
				throw error;
			}
			if (stats.isSymbolicLink()) {
				throw new Error(zh.renameLink);
			}
			if (stats.isDirectory()) {
				dirs.push(child);
				await visit(child);
			} else if (stats.isFile()) {
				files.push({ path: child, size: stats.size, mtimeNs: stats.mtimeNs });
			}
		}
	}
	await visit('');
	return {
		dirs: dirs.sort(comparePaths),
		files: files.sort((a, b) => comparePaths(a.path, b.path)),
	};
}

async function scanCopiedTree(root: string): Promise<CopiedTreeScan> {
	const dirs: string[] = [];
	const files: string[] = [];
	async function visit(relative: string): Promise<void> {
		const dir = relative ? join(root, relative) : root;
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				throw new Error(zh.renameLink);
			}
			if (entry.isDirectory()) {
				dirs.push(child);
				await visit(child);
			} else if (entry.isFile()) {
				files.push(child);
			}
		}
	}
	await visit('');
	return {
		dirs: dirs.sort(comparePaths),
		files: files.sort(comparePaths),
	};
}

async function sameBytes(first: string, second: string): Promise<boolean> {
	const [handleA, handleB] = await Promise.all([open(first, 'r'), open(second, 'r')]);
	try {
		const [statA, statB] = await Promise.all([handleA.stat(), handleB.stat()]);
		if (statA.size !== statB.size) {
			return false;
		}
		const bufA = Buffer.allocUnsafe(65536);
		const bufB = Buffer.allocUnsafe(65536);
		let offset = 0;
		while (offset < statA.size) {
			const [readA, readB] = await Promise.all([handleA.read(bufA, 0, bufA.length, offset), handleB.read(bufB, 0, bufB.length, offset)]);
			if (readA.bytesRead !== readB.bytesRead || readA.bytesRead === 0) {
				return false;
			}
			if (!bufA.subarray(0, readA.bytesRead).equals(bufB.subarray(0, readB.bytesRead))) {
				return false;
			}
			offset += readA.bytesRead;
		}
		return true;
	} finally {
		await Promise.all([handleA.close(), handleB.close()]);
	}
}

function sameList(first: readonly string[], second: readonly string[]): boolean {
	return first.length === second.length && first.every((item, index) => item === second[index]);
}

function sameSourceFiles(before: readonly SourceFileStat[], after: readonly SourceFileStat[]): boolean {
	return (
		before.length === after.length &&
		before.every(
			(item, index) => item.path === after[index].path && item.size === after[index].size && item.mtimeNs === after[index].mtimeNs,
		)
	);
}

export async function copyBookToICloud(
	sourceRoot: string,
	options: {
		icloudRoot?: string;
		trashItem(fullPath: string): Promise<void>;
		copyOne?(src: string, dst: string): Promise<void>;
	},
): Promise<string> {
	const icloudRoot = options.icloudRoot ?? currentICloudRoot();
	if (isBookInICloud(sourceRoot, icloudRoot)) {
		throw new Error(zh.saveToICloudAlready);
	}
	if (!(await isICloudDriveAvailable(icloudRoot))) {
		throw new Error(zh.icloudUnavailable);
	}
	const booksDir = icloudBooksRoot(icloudRoot);
	const bookName = basename(sourceRoot);
	const targetDir = join(booksDir, bookName);
	if (await info(targetDir)) {
		throw new Error(zh.saveToICloudExists);
	}
	await mkdir(booksDir, { recursive: true });
	const partialDir = join(booksDir, `${bookName}.partial`);
	await mkdir(partialDir);
	const copyOne = options.copyOne ?? copyFile;
	try {
		const planned = await scanSourceTree(sourceRoot);
		for (const dir of planned.dirs) {
			await mkdir(join(partialDir, dir), { recursive: true });
		}
		for (const file of planned.files) {
			try {
				await copyOne(join(sourceRoot, file.path), join(partialDir, file.path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					throw new Error(zh.saveToICloudChanged);
				}
				throw error;
			}
		}
		const copiedNow = await scanCopiedTree(partialDir);
		const plannedPaths = planned.files.map((file) => file.path);
		if (!sameList(planned.dirs, copiedNow.dirs) || !sameList(plannedPaths, copiedNow.files)) {
			throw new Error(zh.saveToICloudVerifyFailed);
		}
		for (const file of copiedNow.files) {
			let matched: boolean;
			try {
				matched = await sameBytes(join(sourceRoot, file), join(partialDir, file));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					throw new Error(zh.saveToICloudChanged);
				}
				throw error;
			}
			if (!matched) {
				const current = await scanSourceTree(sourceRoot);
				throw new Error(
					sameList(planned.dirs, current.dirs) && sameSourceFiles(planned.files, current.files)
						? zh.saveToICloudVerifyFailed
						: zh.saveToICloudChanged,
				);
			}
		}
		const sourceAfter = await scanSourceTree(sourceRoot);
		if (!sameList(planned.dirs, sourceAfter.dirs) || !sameSourceFiles(planned.files, sourceAfter.files)) {
			throw new Error(zh.saveToICloudChanged);
		}
		try {
			await mkdir(targetDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new Error(zh.saveToICloudExists);
			}
			throw error;
		}
		await rename(partialDir, targetDir);
		return targetDir;
	} catch (error) {
		await options.trashItem(partialDir).catch(() => {});
		throw error;
	}
}
