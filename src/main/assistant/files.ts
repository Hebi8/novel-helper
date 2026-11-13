import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** Atomic replacement must replace the link's target, never the link itself. */
export async function writeTarget(file: string): Promise<string> {
	try {
		return await realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	const link = await readlink(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT' && error.code !== 'EINVAL') {
			throw error;
		}
		return undefined;
	});
	return link === undefined ? join(await writeTarget(dirname(file)), basename(file)) : writeTarget(resolve(dirname(file), link));
}
