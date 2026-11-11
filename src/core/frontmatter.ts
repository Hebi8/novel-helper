// Sets one field in the YAML frontmatter of a Markdown file and leaves every
// other character of the file as it was: other fields, their order, comments,
// the body.

import { Document, isMap, isScalar, parseDocument } from 'yaml';

export type FieldValue = string | boolean | string[];

const BLOCK = /^(﻿?---[ \t]*\r?\n)(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** The value on one line: `true`, `人物`, `[小满, 林姑娘]`, quoted where YAML needs it. */
function inline(value: FieldValue): string {
	const doc = new Document(value);
	if (Array.isArray(value)) {
		(doc.contents as { flow?: boolean }).flow = true;
	}
	return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

/**
 * `content` with `key` set to `value` in its frontmatter. An existing field
 * keeps its place (a comment after it stays), a new one goes last, and a file
 * without frontmatter gets one. Throws when the frontmatter is not a YAML
 * mapping, since there is no telling where the field would go.
 */
export function setField(content: string, key: string, value: FieldValue): string {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const field = `${key}: ${inline(value)}`;
	const block = BLOCK.exec(content);
	if (!block) {
		const bom = content.startsWith('﻿') ? '﻿' : '';
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
		throw new Error(doc.errors[0].message);
	}
	if (doc.contents !== null && !isMap(doc.contents)) {
		throw new Error('the frontmatter is not a list of fields');
	}
	const pair = doc.contents?.items.find((item) => isScalar(item.key) && item.key.value === key);
	if (!pair || !isScalar(pair.key) || !pair.key.range) {
		return content.slice(0, start + yaml.length) + (yaml ? eol : '') + field + content.slice(start + yaml.length);
	}
	const from = pair.key.range[0];
	const node = pair.value as { range?: [number, number, number] | null } | null;
	// A field with nothing after its colon has no value node: it ends at the colon.
	let to = node?.range ? node.range[1] : yaml.indexOf(':', pair.key.range[1]) + 1;
	// A value written over several lines ends after its last line break; that break stays.
	while (/\s/.test(yaml[to - 1])) {
		to--;
	}
	return content.slice(0, start + from) + field + content.slice(start + to);
}
