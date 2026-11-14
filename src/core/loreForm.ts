import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { type FieldValue, FrontmatterError, setField } from './frontmatter';
import { parseAliases } from './loreGroups';
import { frontmatterLength } from './text';

export interface ExtraField {
	key: string;
	kind: 'string' | 'boolean' | 'list';
	value: FieldValue;
}

export interface LoreFormData {
	prefix: string;
	body: string;
	type: string;
	aliases: string[];
	always: boolean;
	summary: string;
	present: {
		type: boolean;
		aliases: boolean;
		always: boolean;
		summary: boolean;
	};
	extras: ExtraField[];
}

const BLOCK = /^(\uFEFF?---[ \t]*\r?\n)(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function readFlowStrings(node: unknown, separator: RegExp): string[] | undefined {
	if (!isSeq(node) || !node.flow) {
		return undefined;
	}
	const items: string[] = [];
	for (const item of node.items) {
		if (!isScalar(item) || typeof item.value !== 'string') {
			return undefined;
		}
		if (!item.value || item.value.trim() !== item.value || separator.test(item.value)) {
			return undefined;
		}
		items.push(item.value);
	}
	return items;
}

/**
 * Parses a lore file into its frontmatter form fields and body when every field
 * in the frontmatter can be edited losslessly through `setField`; otherwise
 * returns `undefined` so the editor displays the raw Markdown source untouched.
 */
export function inspectLoreForm(content: string): LoreFormData | undefined {
	if (content.includes('\r') && !content.includes('\r\n')) {
		return undefined;
	}
	const head = frontmatterLength(content);
	let prefix: string;
	let body: string;
	let type = '';
	let aliases: string[] = [];
	let always = false;
	let summary = '';
	const present = { type: false, aliases: false, always: false, summary: false };
	const extras: ExtraField[] = [];
	if (head === 0) {
		if (/^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(content)) {
			return undefined;
		}
		prefix = content.startsWith('\uFEFF') ? '\uFEFF' : '';
		body = content.slice(prefix.length);
	} else {
		prefix = content.slice(0, head);
		body = content.slice(head);
		const yaml = BLOCK.exec(prefix)?.[2];
		if (yaml !== undefined) {
			const doc = parseDocument(yaml);
			if (doc.errors.length > 0) {
				return undefined;
			}
			if (doc.contents !== null && (!isMap(doc.contents) || doc.contents.flow)) {
				return undefined;
			}
			const seen = new Set<string>();
			for (const pair of doc.contents?.items ?? []) {
				if (
					!isScalar(pair.key) ||
					typeof pair.key.value !== 'string' ||
					!pair.key.value ||
					/[\r\n]/.test(pair.key.value) ||
					!pair.key.range
				) {
					return undefined;
				}
				const key = pair.key.value;
				if (seen.has(key)) {
					return undefined;
				}
				seen.add(key);
				const from = pair.key.range[0];
				const colon = yaml.indexOf(':', pair.key.range[1]);
				if (colon === -1) {
					return undefined;
				}
				const node = pair.value as { range?: [number, number, number] | null } | null;
				let to = node?.range ? node.range[1] : colon + 1;
				while (to > from && /\s/.test(yaml[to - 1])) {
					to--;
				}
				if (/[\r\n]/.test(yaml.slice(from, to))) {
					return undefined;
				}
				const empty = isScalar(pair.value) && pair.value.value === null && pair.value.range?.[0] === pair.value.range?.[1];
				if (key === 'type') {
					if (empty) {
						type = '';
					} else if (isScalar(pair.value) && typeof pair.value.value === 'string' && !/[\r\n]/.test(pair.value.value) && pair.value.value.trim() === pair.value.value) {
						type = pair.value.value;
					} else {
						return undefined;
					}
					present.type = true;
				} else if (key === 'summary') {
					if (empty) {
						summary = '';
					} else if (isScalar(pair.value) && typeof pair.value.value === 'string' && !/[\r\n]/.test(pair.value.value)) {
						summary = pair.value.value;
					} else {
						return undefined;
					}
					present.summary = true;
				} else if (key === 'always') {
					if (empty) {
						always = false;
					} else if (isScalar(pair.value) && typeof pair.value.value === 'boolean') {
						always = pair.value.value;
					} else {
						return undefined;
					}
					present.always = true;
				} else if (key === 'aliases') {
					if (empty) {
						aliases = [];
					} else {
						const list = readFlowStrings(pair.value, /[,，、;；\r\n]/);
						if (!list || new Set(list).size !== list.length) {
							return undefined;
						}
						aliases = list;
					}
					present.aliases = true;
				} else if (isScalar(pair.value) && typeof pair.value.value === 'string' && !/[\r\n]/.test(pair.value.value)) {
					extras.push({ key, kind: 'string', value: pair.value.value });
				} else if (isScalar(pair.value) && typeof pair.value.value === 'boolean') {
					extras.push({ key, kind: 'boolean', value: pair.value.value });
				} else {
					const list = readFlowStrings(pair.value, /[,，、\r\n]/);
					if (!list) {
						return undefined;
					}
					extras.push({ key, kind: 'list', value: list });
				}
			}
		}
	}
	try {
		setField(prefix, 'type', type || 'x');
		setField(prefix, 'aliases', aliases.length ? aliases : ['x']);
		setField(prefix, 'always', !always);
		setField(prefix, 'summary', summary || 'x');
		for (const extra of extras) {
			setField(prefix, extra.key, extra.kind === 'boolean' ? !extra.value : extra.kind === 'list' ? ['x'] : 'x');
		}
	} catch (error) {
		if (error instanceof FrontmatterError) {
			return undefined;
		}
		throw error;
	}
	return { prefix, body, type, aliases, always, summary, present, extras };
}

/**
 * Applies a single field edit on `content` via `setField`, returning `undefined`
 * when the field value did not change or when an absent fixed field was left empty.
 */
export function commitLoreField(content: string, data: LoreFormData, key: string, raw: string | boolean): string | undefined {
	if (key === 'type') {
		const next = String(raw).replace(/[\r\n]+/g, ' ').trim();
		if ((!data.present.type && next === '') || next === data.type) {
			return undefined;
		}
		return setField(content, 'type', next);
	}
	if (key === 'summary') {
		const next = String(raw).replace(/\r?\n+/g, ' ');
		if ((!data.present.summary && next.trim() === '') || next === data.summary) {
			return undefined;
		}
		return setField(content, 'summary', next);
	}
	if (key === 'aliases') {
		const next = parseAliases(String(raw).replace(/[\r\n]+/g, ','));
		if (sameList(next, data.aliases)) {
			return undefined;
		}
		return setField(content, 'aliases', next);
	}
	if (key === 'always') {
		const next = Boolean(raw);
		if (next === data.always) {
			return undefined;
		}
		return setField(content, 'always', next);
	}
	const extra = data.extras.find((item) => item.key === key);
	if (!extra) {
		return undefined;
	}
	if (extra.kind === 'boolean') {
		const next = Boolean(raw);
		return next === extra.value ? undefined : setField(content, key, next);
	}
	if (extra.kind === 'list') {
		const next = String(raw)
			.replace(/[\r\n]+/g, ',')
			.split(/[,，、]/)
			.map((item) => item.trim())
			.filter(Boolean);
		return sameList(next, extra.value as string[]) ? undefined : setField(content, key, next);
	}
	const next = String(raw).replace(/\r?\n+/g, ' ');
	return next === extra.value ? undefined : setField(content, key, next);
}
