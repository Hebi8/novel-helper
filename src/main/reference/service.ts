import { bookFolder } from '../book/names';
import { join } from 'node:path';
import type { BookIndex } from '../book/indexer';
import { scanFiles } from '../book/indexer';
import { bookPath } from '../book/paths';
import { documentText, readOptional } from '../book/files';
import type { BookNode } from '../../core/library';
import { FrontmatterError, setField, type FieldValue } from '../../core/frontmatter';
import { builtinTemplate, fillTemplate, planNewLore, templateNames } from '../../core/loreGroups';
import { firstLeaf, waysFrom } from '../../core/outline';
import { stem } from '../../core/text';
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
	const plan = planNewLore(name, type, index.library.entries(), index.configuration['files.lore']);
	if (!plan.valid) {
		throw new Error(zh.invalidName);
	}
	name = name.trim();
	type = type.trim();
	const path = bookPath(plan.path);
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
	const root = bookFolder(index, kind);
	const path = bookPath(node[kind] ?? [root, ...node.dirs, `${node.name}.md`].join('/'));
	await index.mutate(path, (raw) => (raw === undefined ? '' : undefined));
	return path;
}
export async function quickItems(index: BookIndex): Promise<QuickItem[]> {
	const data = await referenceData(index);
	const chapters: QuickItem[] = index.library
		.chapterList()
		.map((path) => ({ id: `chapter:${path}`, path, title: stem(path), aliases: [], kind: 'chapter' }));
	const lore: QuickItem[] = data.entries.map((entry) => ({
		id: `lore:${entry.id}`,
		path: entry.id,
		title: entry.name,
		aliases: entry.aliases,
		kind: 'lore',
	}));
	const outline: QuickItem[] = data.nodes
		.filter((node) => node.file)
		.map((node) => ({ id: `outline:${node.id}`, path: node.file!, title: node.title, aliases: [], kind: 'outline', line: node.line }));
	const known = new Set([...chapters, ...lore, ...outline].map((item) => item.path));
	const others: QuickItem[] = (await scanFiles(index.root, ''))
		.filter((path) => !known.has(path))
		.map((path) => ({ id: `file:${path}`, path, title: stem(path), aliases: [], kind: 'file' }));
	return [...chapters, ...lore, ...outline, ...others];
}
