import { registerReference } from './reference/ipc';
import type { MainContext } from './context';
import { registerBook } from './book/ipc';
import { registerCompletion } from './completion/ipc';
import { registerSettings } from './settings/ipc';
import { registerSecrets } from './secrets/ipc';
import { registerUsage } from './usage/ipc';
import { registerWindow } from './window/ipc';
// Keep each feature on its own line for independent additions.
// prettier-ignore
const features = [
	registerReference,
	registerBook,
	registerCompletion,
	registerSettings,
	registerSecrets,
	registerUsage,
	registerWindow,
];
export function registerFeatures(context: MainContext): void {
	features.forEach((register) => register(context));
}
