import { realpathSync } from 'node:fs';
import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { conflictCandidate, isUnderICloudRoot } from '../../core/conflict';
import { zh } from '../../renderer/strings';
export type LineEnding = '\n' | '\r\n' | '\r';
export class FileFormatError extends Error {}
const DEFAULT_ICLOUD_ROOT = join(homedir(), 'Library', 'Mobile Documents');
let icloudRoot = DEFAULT_ICLOUD_ROOT;
export function parseTestICloudArg(argv: readonly string[]): string | undefined {
	if (!argv.includes('--test-mode')) {
		return undefined;
	}
	return argv.find((arg) => arg.startsWith('--icloud-dir='))?.slice('--icloud-dir='.length) || undefined;
}
export function setTestICloudRoot(directory: string): void {
	icloudRoot = directory;
}
export function currentICloudRoot(): string {
	return icloudRoot;
}
export function isBookInICloud(bookRoot: string, root = icloudRoot): boolean {
	try {
		return isUnderICloudRoot(realpathSync(bookRoot), realpathSync(root));
	} catch {
		return false;
	}
}
async function readDecoded(file: string): Promise<{ bytes: Buffer; raw: string } | undefined> {
	let bytes: Buffer;
	try {
		bytes = await readFile(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	try {
		return { bytes, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
	} catch {
		throw new FileFormatError(zh.nonUtf8);
	}
}
export async function readOptional(file: string): Promise<string | undefined> {
	return (await readDecoded(file))?.raw;
}
export function documentText(raw: string): { text: string; lineEnding: LineEnding } {
	const endings = new Set(raw.match(/\r\n|\r|\n/g));
	if (endings.size > 1) {
		throw new FileFormatError(zh.mixedLines);
	}
	const lineEnding = (endings.values().next().value ?? '\n') as LineEnding;
	return { text: raw.replace(/\r\n|\r/g, '\n'), lineEnding };
}
export async function readDocument(file: string) {
	const raw = await readOptional(file);
	return raw === undefined ? undefined : documentText(raw);
}
export async function readVersionedDocument(file: string) {
	const found = await readDecoded(file);
	if (!found) {
		return undefined;
	}
	return {
		...documentText(found.raw),
		hash: createHash('sha256').update(found.bytes).digest('hex'),
	};
}
export async function atomicWrite(file: string, text: string): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, text, 'utf8');
	await rename(temporary, file);
}
export async function isDiskConflictCopy(
	root: string,
	relativePath: string,
	inICloud = isBookInICloud(root),
	extensions: readonly string[] = ['.json'],
): Promise<boolean> {
	const candidate = conflictCandidate(relativePath, inICloud, extensions);
	if (candidate === undefined) {
		return false;
	}
	try {
		return (await stat(join(root, candidate))).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}
export async function readAuxiliaryOptional(
	root: string,
	relativePath: string,
	inICloud = isBookInICloud(root),
	extensions: readonly string[] = ['.json'],
): Promise<string | undefined> {
	return (await isDiskConflictCopy(root, relativePath, inICloud, extensions)) ? undefined : readOptional(join(root, relativePath));
}
