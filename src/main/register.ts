import type { MainContext } from './context';
import { registerBook } from './book/ipc';
import { registerCompletion } from './completion/ipc';
import { registerSettings } from './settings/ipc';
import { registerSecrets } from './secrets/ipc';
import { registerUsage } from './usage/ipc';
import { registerWindow } from './window/ipc';
import { registerAssistant } from './assistant/ipc';
// Keep each feature on its own line for independent additions.
// prettier-ignore
const features = [
	registerBook,
	registerCompletion,
	registerSettings,
	registerSecrets,
	registerUsage,
	registerWindow,
	registerAssistant,
];
export function registerFeatures(context: MainContext): void {
	features.forEach((register) => register(context));
}
