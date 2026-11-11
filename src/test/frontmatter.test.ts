import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type FieldValue, FrontmatterError, setField } from '../core/frontmatter';
import { parseLoreEntry } from '../core/library';

const FILE = `---
# 主角
type: 人物
aliases: [小满, 林姑娘]   # 镇上的人这么叫
always: false
summary: 十七岁，雾港邮局的送信员。
---
林小满每天天不亮就出门。

---

她外套的内袋里一直装着一枚铜纽扣。
`;

describe('setField', () => {
	test('changes one field and no other character', () => {
		assert.equal(setField(FILE, 'always', true), FILE.replace('always: false', 'always: true'));
		assert.equal(setField(FILE, 'type', '主角'), FILE.replace('type: 人物', 'type: 主角'));
		assert.equal(
			setField(FILE, 'aliases', ['小满', '满丫头', '林姑娘']),
			FILE.replace('aliases: [小满, 林姑娘]   # 镇上的人这么叫', 'aliases: [小满, 满丫头, 林姑娘]   # 镇上的人这么叫'),
		);
		assert.equal(setField(FILE, 'aliases', []), FILE.replace('[小满, 林姑娘]', '[]'));
	});

	test('a field that is not there yet goes last', () => {
		const file = '---\ntype: 地点\n# 备注\n---\n正文\n';
		assert.equal(setField(file, 'always', true), '---\ntype: 地点\n# 备注\nalways: true\n---\n正文\n');
	});

	test('a file without frontmatter gets one; an empty one is filled', () => {
		assert.equal(setField('雾港的正文。\n', 'always', true), '---\nalways: true\n---\n雾港的正文。\n');
		assert.equal(setField('', 'type', '地点'), '---\ntype: 地点\n---\n');
		assert.equal(setField('---\n---\n正文', 'type', '地点'), '---\ntype: 地点\n---\n正文');
		assert.equal(setField('﻿正文', 'type', '地点'), '﻿---\ntype: 地点\n---\n正文');
		assert.equal(setField('---\n# 只有注释\n---\n正文', 'type', '地点'), '---\n# 只有注释\ntype: 地点\n---\n正文');
	});

	test('a list written over several lines, a field without a value, a multi-line summary', () => {
		const file = '---\naliases:\n  - 小满\n  - 林姑娘\ntype:\nsummary: >\n  十七岁，\n  送信员。\nalways: true\n---\n正文';
		assert.equal(
			setField(file, 'aliases', ['阿满']),
			'---\naliases: [阿满]\ntype:\nsummary: >\n  十七岁，\n  送信员。\nalways: true\n---\n正文',
		);
		assert.equal(setField(file, 'type', '人物'), file.replace('type:\n', 'type: 人物\n'));
		assert.equal(setField(file, 'always', false), file.replace('always: true', 'always: false'));
	});

	test('Windows line ends are kept', () => {
		const file = '---\r\ntype: 人物\r\n---\r\n正文\r\n';
		assert.equal(setField(file, 'always', true), '---\r\ntype: 人物\r\nalways: true\r\n---\r\n正文\r\n');
		assert.equal(setField('正文\r\n第二行\r\n', 'always', true), '---\r\nalways: true\r\n---\r\n正文\r\n第二行\r\n');
	});

	test('values are quoted where YAML needs it, and read back as they were given', () => {
		const aliases = ['老周', 'a, b', '[守塔人]', 'yes', '#七', '周: 伯', '"引号"'];
		const entry = parseLoreEntry('人物/周伯.md', setField(setField('正文', 'aliases', aliases), 'type', '人物: 守塔人'));
		assert.deepEqual(entry.aliases, aliases);
		assert.equal(entry.type, '人物: 守塔人');
		assert.equal(entry.error, undefined);
		assert.equal(setField('', 'summary', `${'很长的摘要'.repeat(40)}`).split('\n').length, 4, 'long values are not folded');
	});

	test('what the entry parser reads follows the edit', () => {
		const edited = setField(setField(FILE, 'always', true), 'aliases', ['阿满']);
		const entry = parseLoreEntry('人物/林小满.md', edited);
		assert.deepEqual([entry.always, entry.aliases, entry.type, entry.summary], [true, ['阿满'], '人物', '十七岁，雾港邮局的送信员。']);
	});

	test('frontmatter that is not valid YAML, or not a list of fields, is refused', () => {
		assert.throws(() => setField('---\naliases: [小满\n---\n正文', 'always', true), (e: FrontmatterError) => e.kind === 'invalid');
		assert.throws(() => setField('---\n- 小满\n- 林姑娘\n---\n正文', 'always', true), (e: FrontmatterError) => e.kind === 'unsupported');
	});

	test('frontmatter written as {…}: a field it has is changed in place, one it lacks is not squeezed in after it', () => {
		const file = '---\n{type: 人物, always: false}\n---\n正文\n';
		assert.equal(setField(file, 'always', true), '---\n{type: 人物, always: true}\n---\n正文\n');
		assert.equal(setField(file, 'type', '主角'), '---\n{type: 主角, always: false}\n---\n正文\n');
		assert.throws(() => setField(file, 'aliases', ['小满']), (e: FrontmatterError) => e.kind === 'unsupported');
	});

	test('a comment inside the value that would be replaced: refused, not dropped', () => {
		const file = '---\ntype: 人物\naliases: # 角色别称\n  - 小满 # 镇上的人这么叫\n  - 林姑娘\nsummary: > # 一句话\n  十七岁，\n  送信员。\nalways: false # 先不常驻\n---\n正文';
		assert.throws(() => setField(file, 'aliases', ['阿满']), (e: FrontmatterError) => e.kind === 'unsupported' && /comment/.test(e.message));
		assert.throws(() => setField(file, 'summary', '送信员'), (e: FrontmatterError) => e.kind === 'unsupported');
		// The other fields of the same file can still be set, and every comment is still there.
		const pinned = setField(file, 'always', true);
		assert.equal(pinned, file.replace('always: false # 先不常驻', 'always: true # 先不常驻'));
		assert.equal(setField(file, 'type', '主角'), file.replace('type: 人物', 'type: 主角'));
		// A comment on the last item of a list is part of the list too.
		const trailing = '---\naliases:\n  - 小满\n  - 林姑娘 # 邮局的人这么叫\ntype: 人物\n---\n';
		assert.throws(() => setField(trailing, 'aliases', ['阿满']), (e: FrontmatterError) => e.kind === 'unsupported');
		assert.equal(setField(trailing, 'type', '主角'), trailing.replace('type: 人物', 'type: 主角'));
	});

	test('fields that are indented, or nested: a new field is not added where it would land somewhere else', () => {
		assert.throws(() => setField('---\n  type: 人物\n  always: false\n---\n', 'aliases', ['小满']), (e: FrontmatterError) => e.kind === 'unsupported');
		assert.equal(setField('---\n  type: 人物\n  always: false\n---\n', 'always', true), '---\n  type: 人物\n  always: true\n---\n');
		const nested = '---\ntype: 人物\nextra:\n  always: false\n  note: x\n---\n';
		assert.equal(setField(nested, 'always', true), '---\ntype: 人物\nextra:\n  always: false\n  note: x\nalways: true\n---\n');
	});

	test('whatever it returns reads back as the same fields with the one change', () => {
		const files = [FILE, '---\n{type: 人物, always: false}\n---\n', '---\ntype: 地点\n# 备注\n---\n', '---\nsummary: |\n  第一行\n  第二行\n---\n', '---\n"always": false\n? type\n: 人物\n---\n'];
		for (const file of files) {
			for (const [key, value] of [['always', true], ['aliases', ['阿满', 'a: b']], ['type', '主角 #1']] as const) {
				const before = parseLoreEntry('人物/x.md', file);
				let after: string;
				try {
					after = setField(file, key, value as FieldValue);
				} catch (error) {
					assert.ok(error instanceof FrontmatterError, String(error));
					continue;
				}
				const entry = parseLoreEntry('人物/x.md', after);
				assert.equal(entry.error, undefined, after);
				assert.deepEqual({ ...entry, [key]: undefined }, { ...before, ...entry, [key]: undefined });
				assert.deepEqual((entry as unknown as Record<string, unknown>)[key], value, after);
				assert.equal(entry.body, before.body);
			}
		}
	});
});
