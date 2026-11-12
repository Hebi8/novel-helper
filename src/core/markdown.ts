// A small Markdown reader for the assistant's panel. It turns text into a
// tree of blocks and inline pieces, and the panel builds elements from that
// tree with text nodes. There is no HTML on the way: tags in what the agent
// writes stay text, and a link is one only when it goes to http, https or
// mailto. Text that is still being streamed is read as far as it goes (a
// code block that is not closed yet runs to the end).

export type Inline =
	| string
	| { type: 'code'; text: string }
	| { type: 'strong' | 'em' | 'del'; children: Inline[] }
	| { type: 'link'; href: string; children: Inline[] };

export type Block =
	| { type: 'paragraph'; children: Inline[] }
	| { type: 'heading'; level: number; children: Inline[] }
	| { type: 'code'; language: string; text: string }
	| { type: 'quote'; children: Block[] }
	| { type: 'list'; ordered: boolean; start: number; items: Block[][] }
	| { type: 'table'; head: Inline[][]; rows: Inline[][][] }
	| { type: 'rule' };

// In order: code, strong, em, strike-through, image or link, a bare address, an escaped character.
const INLINE =
	/(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=[^\s*])([\s\S]*?[^\s*])\*|~~(?=\S)([\s\S]*?\S)~~|(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>"'`，。；、！？（）【】《》「」]+)|\\([\\`*_{}[\]()#+\-.!~|>])/g;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export function parseInline(text: string): Inline[] {
	const out: Inline[] = [];
	const add = (piece: Inline) => {
		if (typeof piece === 'string' && typeof out.at(-1) === 'string') {
			out[out.length - 1] += piece;
		} else if (piece !== '') {
			out.push(piece);
		}
	};
	let at = 0;
	for (const match of text.matchAll(INLINE)) {
		add(text.slice(at, match.index));
		at = match.index + match[0].length;
		const [whole, ticks, code, strong, em, del, image, label, href, bare, escaped] = match;
		if (ticks !== undefined) {
			add({ type: 'code', text: code.replace(/^ (.*) $/s, '$1') });
		} else if (strong !== undefined) {
			add({ type: 'strong', children: parseInline(strong) });
		} else if (em !== undefined) {
			add({ type: 'em', children: parseInline(em) });
		} else if (del !== undefined) {
			add({ type: 'del', children: parseInline(del) });
		} else if (label !== undefined) {
			// No pictures are loaded: an image is shown as a link to it. A link to anywhere else than the web stays as it was written.
			if (SAFE_LINK.test(href)) {
				add({ type: 'link', href, children: image ? [label || href] : parseInline(label) });
			} else {
				add(whole);
			}
		} else if (bare !== undefined) {
			const address = bare.replace(/[.,:;!?)\]]+$/, '');
			add({ type: 'link', href: address, children: [address] });
			add(bare.slice(address.length));
		} else {
			add(escaped);
		}
	}
	add(text.slice(at));
	return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const blank = (line: string) => line.trim() === '';
const indentOf = (line: string) => line.length - line.trimStart().length;

function cells(row: string): Inline[][] {
	const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
	return inner.split(/(?<!\\)\|/).map((cell) => parseInline(cell.trim().replace(/\\\|/g, '|')));
}

function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i];
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]));
}

function parseLines(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (blank(line)) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const body: string[] = [];
			const closes = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
			for (i++; i < lines.length && !closes.test(lines[i]); i++) {
				body.push(lines[i]);
			}
			i++;
			blocks.push({ type: 'code', language: fence[2], text: body.join('\n') });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
			i++;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push({ type: 'rule' });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const body: string[] = [];
			for (; i < lines.length && QUOTE.test(lines[i]); i++) {
				body.push(lines[i].replace(QUOTE, ''));
			}
			blocks.push({ type: 'quote', children: parseLines(body) });
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet) {
			const indent = bullet[1].length;
			const ordered = /\d/.test(bullet[2]);
			const items: string[][] = [];
			for (; i < lines.length; i++) {
				const next = BULLET.exec(lines[i]);
				if (next && next[1].length === indent && !RULE.test(lines[i])) {
					items.push([next[3]]);
				} else if (blank(lines[i])) {
					// A blank line stays in the item only when the item goes on after it.
					const after = lines.slice(i + 1).find((later) => !blank(later));
					if (after === undefined || (indentOf(after) <= indent && BULLET.exec(after)?.[1].length !== indent)) {
						break;
					}
					items.at(-1)!.push('');
				} else if (indentOf(lines[i]) > indent) {
					// What is indented below an item is part of it, the indent of its text taken off.
					items.at(-1)!.push(lines[i].slice(Math.min(indentOf(lines[i]), indent + 2)));
				} else if (!startsBlock(lines, i) && !blank(lines[i - 1])) {
					items.at(-1)!.push(lines[i].trimStart());
				} else {
					break;
				}
			}
			blocks.push({ type: 'list', ordered, start: ordered ? parseInt(bullet[2], 10) : 1, items: items.map(parseLines) });
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
			const head = cells(line);
			const rows: Inline[][][] = [];
			for (i += 2; i < lines.length && lines[i].includes('|') && !blank(lines[i]); i++) {
				rows.push(cells(lines[i]));
			}
			blocks.push({ type: 'table', head, rows });
			continue;
		}
		const body = [line];
		for (i++; i < lines.length && !blank(lines[i]) && !startsBlock(lines, i); i++) {
			body.push(lines[i]);
		}
		// Line breaks inside a paragraph are kept: the panel shows them as written.
		blocks.push({ type: 'paragraph', children: parseInline(body.map((one) => one.trim()).join('\n')) });
	}
	return blocks;
}

export function parseMarkdown(text: string): Block[] {
	return parseLines(text.replace(/\r\n?/g, '\n').split('\n'));
}
