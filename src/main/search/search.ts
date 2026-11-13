import { join } from 'node:path';
import { scanFiles } from '../book/indexer';
import { readDocument } from '../book/files';
import { comparePaths } from '../../core/naturalSort';
import type { SearchResult } from '../../shared/search';
function lower(text: string) {
	let folded = '';
	const starts: number[] = [],
		ends: number[] = [];
	let offset = 0;
	for (const character of text) {
		const part = character.toLowerCase();
		folded += part;
		for (let i = 0; i < part.length; i++) {
			starts.push(offset);
			ends.push(offset + character.length);
		}
		offset += character.length;
	}
	return { folded, starts, ends };
}
export function searchTexts(files: { path: string; text: string }[], query: string): SearchResult {
	const result: SearchResult = { total: 0, groups: [], skipped: [] };
	if (!query) {
		return result;
	}
	const needle = lower(query).folded;
	let shown = 0;
	for (const file of files) {
		const matches = [];
		let offset = 0;
		for (const [line, text] of file.text.split('\n').entries()) {
			const { folded, starts, ends } = lower(text);
			for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
				const column = starts[at];
				result.total++;
				if (shown < 200) {
					matches.push({ line, column, offset: offset + column, length: ends[at + needle.length - 1] - column, text });
					shown++;
				}
			}
			offset += text.length + 1;
		}
		if (matches.length) {
			result.groups.push({ path: file.path, matches });
		}
	}
	return result;
}
export async function searchBook(root: string, query: string): Promise<SearchResult> {
	if (!query) {
		return { total: 0, groups: [], skipped: [] };
	}
	const paths = (await scanFiles(root, '')).sort(comparePaths);
	const files = [],
		skipped: SearchResult['skipped'] = [];
	for (const path of paths) {
		try {
			const document = await readDocument(join(root, path));
			if (document) {
				files.push({ path, text: document.text });
			}
		} catch (error) {
			skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ...searchTexts(files, query), skipped };
}
