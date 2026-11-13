import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** One login-shell lookup shared by all book windows. */
export function cachedLoginPath(read: () => Promise<string>): () => Promise<string> {
	let pending: Promise<string> | undefined;
	return () => (pending ??= read());
}
const loginPath = cachedLoginPath(async () => {
	const { stdout } = await promisify(execFile)(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\0%s\\0" "$PATH"'], { timeout: 15000 });
	return stdout.split('\0')[1];
});
export async function prepareAgentEnvironment(): Promise<void> {
	process.env.PATH = await loginPath();
}
