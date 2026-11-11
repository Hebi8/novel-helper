// Suggests the name of the next chapter or volume from the one before it:
// 第11章 雾里来信 → 第12章 , 第十一章：雾 → 第十二章：, 第一卷 雾港 → 第二卷 ,
// Chapter 9 - Fog → Chapter 10 - , 011 雾 → 012 . The title is left for the writer.

import { parseChineseNumber } from './naturalSort';

/** What a number counts: 第3章, 卷二. */
const COUNTED = '章节回话集卷幕部篇册季折场';
/** Digits anywhere; Chinese numerals only where they number something (第十二…, 卷二, 十二章), not in 一个人. */
const NUMBER = new RegExp(`\\d+|(?<=[第${COUNTED}])[零〇一二两三四五六七八九十百千万]+|[零〇一二两三四五六七八九十百千万]+(?=[${COUNTED}])`);
const DIGITS = '零一二三四五六七八九';
const UNITS = ['', '十', '百', '千'];
const SEPARATORS = /^[\s:：、，,.\-—–_·]+/;

/** 12 → 十二, 105 → 一百零五, 2020 → 二千零二十; up to 99,999,999. */
export function formatChineseNumber(n: number): string {
	if (n === 0) {
		return DIGITS[0];
	}
	if (n >= 10000) {
		const rest = n % 10000;
		return formatChineseNumber(Math.floor(n / 10000)) + '万' + (rest ? (rest < 1000 ? '零' : '') + formatChineseNumber(rest) : '');
	}
	let out = '';
	let gap = false;
	for (let place = 3; place >= 0; place--) {
		const digit = Math.floor(n / 10 ** place) % 10;
		if (digit === 0) {
			gap = out !== '';
			continue;
		}
		out += (gap ? '零' : '') + DIGITS[digit] + UNITS[place];
		gap = false;
	}
	return out.startsWith('一十') ? out.slice(1) : out;
}

/** Writes `n` the way `like` is written: digits (keeping leading zeros) or Chinese numerals (一〇五 or 一百零五). */
function formatLike(n: number, like: string): string {
	if (/^\d/.test(like)) {
		return String(n).padStart(like.startsWith('0') ? like.length : 0, '0');
	}
	if (like.length > 1 && !/[十百千万]/.test(like)) {
		const zero = like.includes('零') ? '零' : '〇';
		return Array.from(String(n), (d) => (d === '0' ? zero : DIGITS[Number(d)])).join('');
	}
	return formatChineseNumber(n);
}

/** `name` up to its title, with its first number replaced; undefined when it has no number. */
function renumbered(name: string, number: (old: number) => number): string | undefined {
	const match = NUMBER.exec(name);
	if (!match) {
		return undefined;
	}
	const old = /^\d/.test(match[0]) ? Number(match[0]) : parseChineseNumber(match[0]);
	const rest = name.slice(match.index + match[0].length);
	// What stays after the number: 章 and the separator that follows it, not the title.
	let kept = '';
	for (let i = 0; i <= rest.length; i++) {
		const separator = SEPARATORS.exec(rest.slice(i));
		if (separator) {
			kept = rest.slice(0, i) + separator[0];
			break;
		}
		if (i === rest.length) {
			kept = COUNTED.includes(rest[0]) ? rest[0] : '';
		}
	}
	return name.slice(0, match.index) + formatLike(number(old), match[0]) + kept;
}

/** The name to suggest after `previous`: the same pattern with the next number. */
export function nextName(previous: string): string | undefined {
	return renumbered(previous, (n) => n + 1);
}

/** The name to suggest for the first of its kind, in the pattern of `example`: 第三幕 回潮 → 第一幕 . */
export function firstName(example: string): string | undefined {
	return renumbered(example, () => 1);
}
