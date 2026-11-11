// Sets one field in the YAML frontmatter of a Markdown file and leaves every
// other character of the file as it was: other fields, their order, comments,
// the body.

import { CST, Document, isMap, isScalar, Lexer, parseDocument } from 'yaml';

export type FieldValue = string | boolean | string[];

const BLOCK = /^(﻿?---[ \t]*\r?\n)(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** The value on one line: `true`, `人物`, `[小满, 林姑娘]`, quoted where YAML needs it. */
export function inline(value: FieldValue): string {
	const doc = new Document(value);
	if (Array.isArray(value)) {
		(doc.contents as { flow?: boolean }).flow = true;
	}
	return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

/**
 * Why a field was not set: the frontmatter is not valid YAML (`invalid`), or
 * it is written in a way that cannot be changed here without touching more
 * than the one field (`unsupported`). Either way nothing was changed.
 */
export class FrontmatterError extends Error {
	constructor(
		readonly kind: 'invalid' | 'unsupported',
		message: string,
	) {
		super(message);
	}
}

function comments(yaml: string): string[] {
	return [...new Lexer().lex(yaml)].filter((token) => CST.tokenType(token) === 'comment');
}

/**
 * `content` with `key` set to `value` in its frontmatter. An existing field
 * keeps its place (a comment after it stays), a new one goes last, and a file
 * without frontmatter gets one. Every other character stays as it is.
 *
 * The result is read back before it is returned: it has to hold the fields
 * it held, in their order, with the one change, and every comment it had.
 * When it would not (frontmatter written as `{…}` that needs a new field, a
 * comment inside the value that is replaced, fields that are indented), a
 * `FrontmatterError` is thrown instead.
 */
export function setField(content: string, key: string, value: FieldValue): string {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const field = `${key}: ${inline(value)}`;
	const block = BLOCK.exec(content);
	if (!block) {
		const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
		return `${bom}---${eol}${field}${eol}---${eol}${content.slice(bom.length)}`;
	}
	const start = block[1].length;
	const yaml = block[2];
	if (yaml === undefined) {
		// `---` right after `---`: nothing in between yet.
		return content.slice(0, start) + field + eol + content.slice(start);
	}
	const doc = parseDocument(yaml);
	if (doc.errors.length) {
		throw new FrontmatterError('invalid', doc.errors[0].message);
	}
	if (doc.contents !== null && !isMap(doc.contents)) {
		throw new FrontmatterError('unsupported', 'the frontmatter is not a list of fields');
	}
	const pair = doc.contents?.items.find((item) => isScalar(item.key) && item.key.value === key);
	let changed: string;
	if (!pair || !isScalar(pair.key) || !pair.key.range) {
		changed = yaml + (yaml ? eol : '') + field;
	} else {
		const from = pair.key.range[0];
		const node = pair.value as { range?: [number, number, number] | null } | null;
		// A field with nothing after its colon has no value node: it ends at the colon.
		let to = node?.range ? node.range[1] : yaml.indexOf(':', pair.key.range[1]) + 1;
		// A value written over several lines ends after its last line break; that break stays.
		while (/\s/.test(yaml[to - 1])) {
			to--;
		}
		changed = yaml.slice(0, from) + field + yaml.slice(to);
	}
	const after = parseDocument(changed);
	const wanted = { ...(doc.toJS() as Record<string, unknown> | null), [key]: value };
	if (after.errors.length || JSON.stringify(after.toJS()) !== JSON.stringify(wanted)) {
		throw new FrontmatterError('unsupported', `setting ${key} here would not leave the other fields as they are`);
	}
	if (JSON.stringify(comments(changed)) !== JSON.stringify(comments(yaml))) {
		throw new FrontmatterError('unsupported', `setting ${key} here would remove a comment`);
	}
	return content.slice(0, start) + changed + content.slice(start + yaml.length);
}
