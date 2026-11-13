import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { FileFormatError, readOptional } from '../book/files';

/** ACP hides ordinary errors, so keep the actionable decoding error in its response. */
export async function readForAgent(file: string): Promise<string | undefined> {
	try {
		return await readOptional(file);
	} catch (error) {
		if (error instanceof FileFormatError) {
			const { RequestError } = await import('@agentclientprotocol/sdk');
			throw RequestError.internalError(undefined, error.message);
		}
		throw error;
	}
}

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
