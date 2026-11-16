import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { conflictCandidate } from '../../core/conflict';
import { zh } from '../../renderer/strings';
export type LineEnding = '\n' | '\r\n' | '\r';
export class FileFormatError extends Error {}
export async function readOptional(file: string): Promise<string | undefined> {
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
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new FileFormatError(zh.nonUtf8);
	}
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
export async function atomicWrite(file: string, text: string): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, text, 'utf8');
	await rename(temporary, file);
}
export async function isDiskConflictCopy(root: string, relativePath: string, extensions: readonly string[] = ['.json']): Promise<boolean> {
	const candidate = conflictCandidate(relativePath, extensions);
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
	extensions: readonly string[] = ['.json'],
): Promise<string | undefined> {
	return (await isDiskConflictCopy(root, relativePath, extensions)) ? undefined : readOptional(join(root, relativePath));
}
