import { join } from 'node:path';
import type { BookIndex } from '../book/indexer';
import { scanFiles } from '../book/indexer';
import { bookPath } from '../book/paths';
import { documentText, readOptional } from '../book/files';
import { globFolders, type BookNode } from '../../core/library';
import { FrontmatterError, setField, type FieldValue } from '../../core/frontmatter';
import { builtinTemplate, fillTemplate, folderForNew, templateNames } from '../../core/loreGroups';
import { nameProblem } from '../../core/book';
import { firstLeaf, waysFrom } from '../../core/outline';
import { dirSegments, stem } from '../../core/text';
import { defaults } from '../../shared/defaults';
import type { ReferenceData, QuickItem } from '../../shared/api';
import { zh, translateReport } from '../../renderer/strings';
export async function referenceData(index: BookIndex): Promise<ReferenceData> {
	const graph = await index.outline();
	return {
		entries: index.library.entries(),
		outlines: index.library.outlines().files.map((file) => file.path),
		nodes: [...graph.nodes.values()].map((node) => ({
			id: node.id,
			title: node.title,
			kind: node.kind,
			file: node.file,
			line: node.line,
			text: node.text,
			children: node.children.map((child) => child.id),
			links: node.links.map((link) => ({ raw: link.raw, target: link.target?.id, problem: link.problem })),
			next: waysFrom(graph, firstLeaf(node)).next?.id,
		})),
	};
}
export async function setLoreField(index: BookIndex, path: string, field: 'always' | 'aliases' | 'type', value: FieldValue): Promise<void> {
	bookPath(path);
	if (!index.library.entry(path)) {
		throw new Error(zh.fileMissing);
	}
	await index.mutate(path, (raw) => {
		if (raw === undefined) {
			throw new Error(zh.fileMissing);
		}
		if (documentText(raw).lineEnding === '\r') {
			throw new Error(zh.invalidLore);
		}
		try {
			return setField(raw, field, value);
		} catch (error) {
			if (error instanceof FrontmatterError) {
				throw new Error(zh.invalidLore);
			}
			throw error;
		}
	});
}
export async function createLore(index: BookIndex, name: string, type: string): Promise<string> {
	const entries = index.library.entries();
	const folder = folderForNew(type, entries, defaults['files.lore'].flatMap(globFolders));
	if (
		nameProblem(
			name,
			entries.filter((entry) => dirSegments(entry.id).join('/') === folder).map((entry) => stem(entry.id)),
		)
	) {
		throw new Error(zh.invalidName);
	}
	name = name.trim();
	const path = bookPath(`${folder}/${name}.md`);
	let content = builtinTemplate(type, translateReport);
	for (const template of templateNames(type)) {
		const raw = await readOptional(join(index.root, '.novel-helper/templates', `${template}.md`));
		if (raw !== undefined) {
			try {
				content = fillTemplate(raw, path, name, type);
			} catch {
				throw new Error(zh.invalidTemplate);
			}
			break;
		}
	}
	await index.mutate(path, (raw) => {
		if (raw !== undefined) {
			throw new Error(zh.fileExists);
		}
		return content;
	});
	return path;
}
export async function openCompanion(index: BookIndex, nodePath: string, kind: 'outline' | 'summary'): Promise<string> {
	bookPath(nodePath);
	const find = (node: BookNode): BookNode | undefined => (node.path === nodePath ? node : node.children.map(find).find(Boolean));
	const node = find(index.book.tree)!;
	const root = index.library.roots(kind)[0] ?? defaults[kind === 'outline' ? 'files.outlines' : 'files.summaries'].flatMap(globFolders)[0];
	const path = bookPath(node[kind] ?? [root, ...node.dirs, `${node.name}.md`].join('/'));
	await index.mutate(path, (raw) => raw ?? '');
	return path;
}
export async function quickItems(index: BookIndex): Promise<QuickItem[]> {
	const data = await referenceData(index);
	const chapters: QuickItem[] = index.library.chapterList().map((path) => ({ path, title: stem(path), aliases: [], kind: 'chapter' }));
	const lore: QuickItem[] = data.entries.map((entry) => ({ path: entry.id, title: entry.name, aliases: entry.aliases, kind: 'lore' }));
	const outline: QuickItem[] = data.nodes
		.filter((node) => node.file)
		.map((node) => ({ path: node.file!, title: node.title, aliases: [], kind: 'outline', line: node.line }));
	const known = new Set([...chapters, ...lore, ...outline].map((item) => item.path));
	const others: QuickItem[] = (await scanFiles(index.root, ''))
		.filter((path) => !known.has(path))
		.map((path) => ({ path, title: stem(path), aliases: [], kind: 'file' }));
	return [...chapters, ...lore, ...outline, ...others];
}
