import type { OpenResult } from '../../shared/api';
/** Concurrent opens of a canonical book root share its preparation and window creation. */
export class BookOpenings {
	private readonly pending = new Map<string, Promise<OpenResult>>();
	run(root: string, open: () => Promise<OpenResult>): Promise<OpenResult> {
		let result = this.pending.get(root);
		if (!result) {
			result = open().finally(() => this.pending.delete(root));
			this.pending.set(root, result);
		}
		return result;
	}
}
