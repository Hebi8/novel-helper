import { useSyncExternalStore } from 'react';
import type { DocumentModel } from './document';
const noSubscribe = () => () => {};
export function useDocument(model?: DocumentModel): void {
	useSyncExternalStore(model?.subscribe ?? noSubscribe, () => model?.version ?? 0);
}
