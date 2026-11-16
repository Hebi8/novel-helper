import { join } from 'node:path';
export const USER_DATA_DIR_NAME = 'Novel Helper';
export function resolveUserDataPath(appDataPath: string, argv: readonly string[]): string {
	const override = argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
	return override || join(appDataPath, USER_DATA_DIR_NAME);
}
