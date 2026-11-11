// Natural ordering for chapter paths: 第2章 before 第10章, 第九章 before 第十二章,
// 卷二 before 卷十. Arabic, full-width and Chinese numerals compare by value.

const DIGIT: Record<string, number> = {
	零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const BIG: Record<string, number> = { 万: 1e4, 亿: 1e8 };

/** `十二` → 12, `一百零五` → 105, `一〇五` → 105, `两千零二十` → 2020. */
export function parseChineseNumber(text: string): number {
	const chars = Array.from(text);
	if (!chars.some((c) => c in UNIT || c in BIG)) {
		return Number(chars.map((c) => DIGIT[c]).join(''));
	}
	let total = 0;
	let section = 0;
	let current = 0;
	for (const c of chars) {
		if (c in DIGIT) {
			current = DIGIT[c];
		} else if (c in UNIT) {
			section += (current || 1) * UNIT[c];
			current = 0;
		} else {
			total += (section + current || 1) * BIG[c];
			section = 0;
			current = 0;
		}
	}
	return total + section + current;
}

interface Token {
	text: string;
	value?: number;
}

const TOKEN = /(\d+)|([零〇一二两三四五六七八九十百千万亿]+)|([^\d零〇一二两三四五六七八九十百千万亿]+)/g;

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	for (const m of text.normalize('NFKC').matchAll(TOKEN)) {
		if (m[1] !== undefined) {
			tokens.push({ text: m[1], value: Number(m[1]) });
		} else if (m[2] !== undefined) {
			tokens.push({ text: m[2], value: parseChineseNumber(m[2]) });
		} else {
			tokens.push({ text: m[3] });
		}
	}
	return tokens;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares two names with embedded numbers by value. */
export function compareNatural(a: string, b: string): number {
	const ta = tokenize(a);
	const tb = tokenize(b);
	for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
		const x = ta[i];
		const y = tb[i];
		if (x.value !== undefined && y.value !== undefined) {
			if (x.value !== y.value) {
				return x.value - y.value;
			}
		} else if (x.text !== y.text) {
			return compareText(x.text, y.text);
		}
	}
	return ta.length - tb.length || compareText(a, b);
}

function withoutExtension(segment: string): string {
	const dot = segment.lastIndexOf('.');
	return dot > 0 ? segment.slice(0, dot) : segment;
}

/** Compares `/`-separated relative paths segment by segment; file extensions are ignored. */
export function comparePaths(a: string, b: string): number {
	const sa = a.split('/');
	const sb = b.split('/');
	sa[sa.length - 1] = withoutExtension(sa[sa.length - 1]);
	sb[sb.length - 1] = withoutExtension(sb[sb.length - 1]);
	for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
		const order = compareNatural(sa[i], sb[i]);
		if (order !== 0) {
			return order;
		}
	}
	return sa.length - sb.length || compareText(a, b);
}
