import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}
export async function atomicWrite(file: string, text: string): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, text, 'utf8');
	await rename(temporary, file);
}
