import type { BookIndex } from '../book/indexer';
import { bookNames } from '../book/names';
export async function storyNames(index: BookIndex) {
	return bookNames(index);
}
