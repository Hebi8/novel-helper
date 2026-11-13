import { zh } from '../../renderer/strings';
const changing = new Set<string>();
export function assertBookAvailable(root: string): void {
	if (changing.has(root)) {
		throw new Error(zh.bookBusy);
	}
}
export async function changeBook<T>(root: string, operation: () => Promise<T>): Promise<T> {
	assertBookAvailable(root);
	changing.add(root);
	try {
		return await operation();
	} finally {
		changing.delete(root);
	}
}
