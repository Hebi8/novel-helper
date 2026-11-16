import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsPromises = require('node:fs/promises');
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { isBookInICloud } from '../main/book/files';
import {
	copyBookToICloud,
	icloudBooksRoot,
	icloudDriveRoot,
	isICloudDriveAvailable,
	isICloudDriveAvailableSync,
	listICloudBooks,
	watchICloudBooks,
} from '../main/book/icloud';
import { WindowStore } from '../main/window/state';

async function listAllRelativeFiles(root: string, relative = ''): Promise<string[]> {
	const dir = relative ? join(root, relative) : root;
	const entries = await readdir(dir, { withFileTypes: true });
	const results: string[] = [];
	for (const entry of entries) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			results.push(...(await listAllRelativeFiles(root, child)));
		} else if (entry.isFile()) {
			results.push(child);
		}
	}
	return results.sort();
}

describe('iCloud Drive books', () => {
	test('checks com~apple~CloudDocs availability and shares Mobile Documents boundary with isBookInICloud', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-unit-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const mobileDocs = join(root, 'Mobile Documents');
		assert.equal(isICloudDriveAvailableSync(mobileDocs), false);
		assert.equal(await isICloudDriveAvailable(mobileDocs), false);

		await mkdir(mobileDocs, { recursive: true });
		assert.equal(isICloudDriveAvailableSync(mobileDocs), false);
		assert.equal(await isICloudDriveAvailable(mobileDocs), false);

		const drive = icloudDriveRoot(mobileDocs);
		await mkdir(drive, { recursive: true });
		assert.equal(isICloudDriveAvailableSync(mobileDocs), true);
		assert.equal(await isICloudDriveAvailable(mobileDocs), true);

		const bookInDrive = join(icloudBooksRoot(mobileDocs), '雾港');
		await mkdir(bookInDrive, { recursive: true });
		assert.equal(isBookInICloud(bookInDrive, mobileDocs), true);
	});

	test('copies book byte-for-byte via .partial, reuses skipsFolder exclusions, and leaves source untouched', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-copy-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const mobileDocs = join(root, 'Mobile Documents');
		await mkdir(icloudDriveRoot(mobileDocs), { recursive: true });
		const source = join(root, '雾港');
		await cp(resolve('examples'), source, { recursive: true });

		// Skipped folders: .git, node_modules (root and nested), and legacy .novel-helper/snapshots.
		await mkdir(join(source, '.git/objects'), { recursive: true });
		await writeFile(join(source, '.git/HEAD'), 'ref: refs/heads/main\n');
		await mkdir(join(source, 'node_modules/pkg'), { recursive: true });
		await writeFile(join(source, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
		await mkdir(join(source, '资料/node_modules/nested'), { recursive: true });
		await writeFile(join(source, '资料/node_modules/nested/a.js'), '1;\n');
		await mkdir(join(source, '.novel-helper/snapshots/turns'), { recursive: true });
		await writeFile(join(source, '.novel-helper/snapshots/turns/000001.json'), '{"id":1}\n');

		// Non-skipped special files: binary data, CRLF text, hidden config, templates, empty folder.
		await mkdir(join(source, '摘要/空卷'), { recursive: true });
		await mkdir(join(source, '.novel-helper/templates'), { recursive: true });
		await writeFile(join(source, '.novel-helper/templates/人物.md'), '---\ntype: 人物\n---\n');
		await mkdir(join(source, '.claude'), { recursive: true });
		await writeFile(join(source, '.claude/settings.json'), '{"permissions":{}}\n');
		await writeFile(join(source, '设定/crlf.md'), '第一行\r\n第二行\r\n');
		const binaryBytes = Buffer.from([0, 1, 2, 255, 128, 64, 0, 99]);
		await mkdir(join(source, '资料'), { recursive: true });
		await writeFile(join(source, '资料/map.bin'), binaryBytes);

		const beforeFiles = await listAllRelativeFiles(source);
		const beforeBytes = new Map<string, Buffer>();
		for (const file of beforeFiles) {
			beforeBytes.set(file, await readFile(join(source, file)));
		}

		let sawPartial = false;
		const trashed: string[] = [];
		const target = await copyBookToICloud(source, {
			icloudRoot: mobileDocs,
			trashItem: async (fullPath) => {
				trashed.push(fullPath);
			},
			copyOne: async (src, dst) => {
				if (dst.includes('雾港.partial')) {
					sawPartial = true;
				}
				await copyFile(src, dst);
			},
		});

		assert.equal(sawPartial, true);
		assert.deepEqual(trashed, []);
		assert.equal(target, join(icloudBooksRoot(mobileDocs), '雾港'));
		assert.equal(existsSync(join(icloudBooksRoot(mobileDocs), '雾港.partial')), false);
		assert.equal(existsSync(join(target, '摘要/空卷')), true);

		const copiedFiles = await listAllRelativeFiles(target);
		const expectedCopied = beforeFiles.filter(
			(file) =>
				!file.startsWith('.git/') &&
				!file.startsWith('node_modules/') &&
				!file.includes('/node_modules/') &&
				!file.startsWith('.novel-helper/snapshots/'),
		);
		assert.deepEqual(copiedFiles, expectedCopied);
		assert.ok(copiedFiles.includes('.novel-helper/project.json'));
		assert.ok(copiedFiles.some((file) => file.startsWith('.novel-helper/buoys/')));
		assert.ok(copiedFiles.some((file) => file.startsWith('.novel-helper/templates/')));
		assert.ok(copiedFiles.includes('.claude/settings.json'));
		assert.ok(copiedFiles.includes('资料/map.bin'));

		for (const file of copiedFiles) {
			assert.deepEqual(await readFile(join(target, file)), beforeBytes.get(file));
		}

		// Source book is completely unchanged, including skipped folders.
		const afterSourceFiles = await listAllRelativeFiles(source);
		assert.deepEqual(afterSourceFiles, beforeFiles);
		for (const file of afterSourceFiles) {
			assert.deepEqual(await readFile(join(source, file)), beforeBytes.get(file));
		}
	});

	test('refuses existing target name and trashes .partial on mid-copy or verification failure', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-fail-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const mobileDocs = join(root, 'Mobile Documents');
		const booksDir = icloudBooksRoot(mobileDocs);
		await mkdir(icloudDriveRoot(mobileDocs), { recursive: true });
		const trashDir = join(root, 'trash');
		await mkdir(trashDir, { recursive: true });

		const source = join(root, '雾港');
		await cp(resolve('examples'), source, { recursive: true });
		const originalFiles = await listAllRelativeFiles(source);
		const originalSnapshot = new Map<string, Buffer>();
		for (const file of originalFiles) {
			originalSnapshot.set(file, await readFile(join(source, file)));
		}

		const trashed: string[] = [];
		const trashItem = async (fullPath: string) => {
			trashed.push(basename(fullPath));
			await rename(fullPath, join(trashDir, `${trashed.length}-${basename(fullPath)}`));
		};

		// 1. Mid-copy failure after writing two files: .partial is moved to Trash, target not created, source intact.
		let copiedCount = 0;
		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem,
				copyOne: async (src, dst) => {
					copiedCount++;
					if (copiedCount === 3) {
						throw new Error('磁盘空间不足');
					}
					await copyFile(src, dst);
				},
			}),
			/磁盘空间不足/,
		);
		assert.deepEqual(trashed, ['雾港.partial']);
		assert.equal(existsSync(join(booksDir, '雾港.partial')), false);
		assert.equal(existsSync(join(booksDir, '雾港')), false);

		// 2. Byte-by-byte verification mismatch: .partial is moved to Trash, not renamed to target.
		let corrupted = false;
		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem,
				copyOne: async (src, dst) => {
					await copyFile(src, dst);
					if (!corrupted && dst.endsWith('.md')) {
						corrupted = true;
						const bytes = await readFile(dst);
						bytes[0] ^= 0xff;
						await writeFile(dst, bytes);
					}
				},
			}),
			/校验不一致/,
		);
		assert.deepEqual(trashed, ['雾港.partial', '雾港.partial']);
		assert.equal(existsSync(join(booksDir, '雾港.partial')), false);
		assert.equal(existsSync(join(booksDir, '雾港')), false);

		// 3. Existing same-named folder in Novel Helper/: refuses without touching existing target or trashing anything.
		await mkdir(join(booksDir, '雾港'), { recursive: true });
		await writeFile(join(booksDir, '雾港/existing.md'), '原有的云端书稿');
		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem,
			}),
			/iCloud 里已有同名的书/,
		);
		assert.deepEqual(trashed, ['雾港.partial', '雾港.partial']);
		assert.equal(await readFile(join(booksDir, '雾港/existing.md'), 'utf8'), '原有的云端书稿');
		await rm(join(booksDir, '雾港'), { recursive: true, force: true });

		// 4. Copy failure where moving .partial to Trash also fails: reports both errors and the leftover .partial path without auto-deleting it.
		const partialPath = join(booksDir, '雾港.partial');
		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem: async () => {
					throw new Error('废纸篓不可用');
				},
				copyOne: async () => {
					throw new Error('磁盘空间不足');
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /磁盘空间不足/);
				assert.match(error.message, /废纸篓不可用/);
				assert.ok(error.message.includes(partialPath));
				return true;
			},
		);
		assert.equal(existsSync(partialPath), true);
		await rm(partialPath, { recursive: true, force: true });

		// Verify source book never changed across all failure scenarios.
		assert.deepEqual(await listAllRelativeFiles(source), originalFiles);
		for (const file of originalFiles) {
			assert.deepEqual(await readFile(join(source, file)), originalSnapshot.get(file));
		}
	});

	test('aborts and trashes .partial if a source file changes after its own byte comparison finishes', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-race-src-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const mobileDocs = join(root, 'Mobile Documents');
		const booksDir = icloudBooksRoot(mobileDocs);
		await mkdir(icloudDriveRoot(mobileDocs), { recursive: true });
		const trashDir = join(root, 'trash');
		await mkdir(trashDir, { recursive: true });

		const source = join(root, '雾港');
		await cp(resolve('examples'), source, { recursive: true });
		const originalFiles = await listAllRelativeFiles(source);
		const originalBytes = new Map<string, Buffer>();
		for (const file of originalFiles) {
			originalBytes.set(file, await readFile(join(source, file)));
		}

		const trashed: string[] = [];
		const trashItem = async (fullPath: string) => {
			trashed.push(basename(fullPath));
			await rename(fullPath, join(trashDir, `${trashed.length}-${basename(fullPath)}`));
		};

		// Touch mtime of the first verified source file while a later file is being verified (bytes stay identical).
		const realOpen = fsPromises.open;
		const verifiedSources: string[] = [];
		let touched = false;
		const openSpy = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
			const filePath = String(args[0]);
			if (filePath.startsWith(`${source}/`)) {
				verifiedSources.push(filePath);
				if (!touched && verifiedSources.length === 3) {
					touched = true;
					const future = new Date(Date.now() + 2000);
					await utimes(verifiedSources[0], future, future);
				}
			}
			return realOpen(...args);
		});

		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem,
			}),
			/复制期间书被改动了，没有存到 iCloud，请再试一次/,
		);
		openSpy.mock.restore();

		assert.equal(touched, true);
		assert.deepEqual(trashed, ['雾港.partial']);
		assert.equal(existsSync(join(booksDir, '雾港.partial')), false);
		assert.equal(existsSync(join(booksDir, '雾港')), false);

		// Source book contents are completely unchanged.
		assert.deepEqual(await listAllRelativeFiles(source), originalFiles);
		for (const file of originalFiles) {
			assert.deepEqual(await readFile(join(source, file)), originalBytes.get(file));
		}
	});

	test('does not overwrite a target created after the initial check and leaves target untouched if rename fails', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-race-dst-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const mobileDocs = join(root, 'Mobile Documents');
		const booksDir = icloudBooksRoot(mobileDocs);
		await mkdir(icloudDriveRoot(mobileDocs), { recursive: true });
		const trashDir = join(root, 'trash');
		await mkdir(trashDir, { recursive: true });

		const source = join(root, '雾港');
		await cp(resolve('examples'), source, { recursive: true });
		const targetDir = join(booksDir, '雾港');

		const trashed: string[] = [];
		const trashItem = async (fullPath: string) => {
			trashed.push(basename(fullPath));
			await rename(fullPath, join(trashDir, `${trashed.length}-${basename(fullPath)}`));
		};

		// 1. Sync creates an empty target folder right after verification finishes, right before mkdir(targetDir).
		const realMkdir = fsPromises.mkdir;
		let syncedEmptyIno = 0;
		const mkdirSpy = t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof fsPromises.mkdir>) => {
			if (String(args[0]) === targetDir && args[1] === undefined) {
				await realMkdir(targetDir);
				syncedEmptyIno = (await stat(targetDir)).ino;
			}
			return realMkdir(...args);
		});

		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem,
			}),
			/iCloud 里已有同名的书/,
		);
		mkdirSpy.mock.restore();

		assert.notEqual(syncedEmptyIno, 0);
		assert.deepEqual(trashed, ['雾港.partial']);
		assert.equal(existsSync(join(booksDir, '雾港.partial')), false);
		assert.equal((await stat(targetDir)).ino, syncedEmptyIno);
		assert.deepEqual(await readdir(targetDir), []);
		await rm(targetDir, { recursive: true, force: true });

		// 2. Sync places a file inside targetDir between mkdir(targetDir) and rename(partialDir, targetDir).
		const realRename = fsPromises.rename;
		const renameSpy = t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof fsPromises.rename>) => {
			if (String(args[0]) === `${targetDir}.partial` && String(args[1]) === targetDir) {
				await writeFile(join(targetDir, 'synced.md'), '同步进来的内容');
			}
			return realRename(...args);
		});

		await assert.rejects(
			copyBookToICloud(source, {
				icloudRoot: mobileDocs,
				trashItem,
			}),
		);
		renameSpy.mock.restore();

		assert.deepEqual(trashed, ['雾港.partial', '雾港.partial']);
		assert.equal(existsSync(join(booksDir, '雾港.partial')), false);
		assert.equal(await readFile(join(targetDir, 'synced.md'), 'utf8'), '同步进来的内容');
		assert.deepEqual(await readdir(targetDir), ['synced.md']);
	});

	test('lists iCloud book folders and watches for newly synced books while ignoring .partial and hidden items', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-icloud-watch-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const mobileDocs = join(root, 'Mobile Documents');
		assert.deepEqual(await listICloudBooks(mobileDocs), []);

		// Start watching before `Novel Helper/` even exists under `com~apple~CloudDocs`.
		await mkdir(icloudDriveRoot(mobileDocs), { recursive: true });
		assert.deepEqual(await listICloudBooks(mobileDocs), []);

		const updates: string[][] = [];
		const stop = watchICloudBooks(mobileDocs, (books) => updates.push(books));
		t.after(stop);

		const booksDir = icloudBooksRoot(mobileDocs);
		await mkdir(join(booksDir, '第2本.partial'), { recursive: true });
		await mkdir(join(booksDir, '.hidden'), { recursive: true });
		await mkdir(join(booksDir, '第10本'), { recursive: true });
		await writeFile(join(booksDir, 'readme.txt'), 'not a book folder');
		await mkdir(join(booksDir, '第2本'), { recursive: true });

		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			if (
				updates.some(
					(list) =>
						list.length === 2 &&
						list[0] === join(booksDir, '第2本') &&
						list[1] === join(booksDir, '第10本'),
				)
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		assert.deepEqual(await listICloudBooks(mobileDocs), [join(booksDir, '第2本'), join(booksDir, '第10本')]);
		assert.deepEqual(updates.at(-1), [join(booksDir, '第2本'), join(booksDir, '第10本')]);

		// Adding another book later triggers the live watcher on Novel Helper/ directly.
		await mkdir(join(booksDir, '第3本'), { recursive: true });
		const secondDeadline = Date.now() + 3000;
		while (Date.now() < secondDeadline) {
			if (updates.at(-1)?.length === 3) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		assert.deepEqual(updates.at(-1), [join(booksDir, '第2本'), join(booksDir, '第3本'), join(booksDir, '第10本')]);
	});

	test('WindowStore.replaceRecent swaps the old path for the new iCloud path without duplicates', async (t) => {
		const root = await mkdtemp(join(tmpdir(), 'novel-window-recent-'));
		t.after(() => rm(root, { recursive: true, force: true }));

		const store = new WindowStore(root);
		store.opened('/local/other');
		store.opened('/local/book');
		assert.deepEqual(store.value.recent, ['/local/book', '/local/other']);

		store.opened('/icloud/hebi8L/book');
		store.replaceRecent('/local/book', '/icloud/hebi8L/book');
		assert.deepEqual(store.value.recent, ['/icloud/hebi8L/book', '/local/other']);
		assert.deepEqual(new WindowStore(root).value.recent, ['/icloud/hebi8L/book', '/local/other']);
	});
});
