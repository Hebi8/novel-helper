// Where a chapter is on the outline graph: one buoy in a node, or two (the
// text is on its way from one node to the next, or tells two nodes at once).
// Buoys sit on leaves. Every change is kept as a mark, the place in the
// chapter's text where the buoys were found to be so; the last mark is where
// the chapter is now. The marks of a chapter live in a file of their own in
// the story folder, next to nothing the writer writes.

import type { NodeSource, PositionSource } from './context';
import { ancestors, firstLeaf, type OutlineGraph, type OutlineNode, trail, waysFrom } from './outline';

/** `in`: one node. `bridge`: on the way from the first node to the second. `parallel`: both at once. */
export type BuoyKind = 'in' | 'bridge' | 'parallel';

export interface BuoyRef {
	/** The node's id in the outline graph. */
	id: string;
	/** Its title when the mark was made: what is shown when the node is gone, and what it is found by when only its place in the file changed. */
	title: string;
}

export interface BuoyState {
	kind: BuoyKind;
	/** One node for `in`, two for the others. */
	nodes: BuoyRef[];
}

/** Who set the buoys: the first guess, the model's regular look, the writer, the model's search over the whole outline. */
export type MarkSource = 'init' | 'auto' | 'manual' | 'relocate';

export interface Mark {
	/** Offset in the chapter file (UTF-16 units) up to which the text was looked at. */
	at: number;
	/** The text right before `at`, to find the place again after the text before it changed. */
	before: string;
	/** Length of the chapter's text, frontmatter aside, at the time: the next look comes when it has grown enough. */
	chars: number;
	/** ISO 8601. */
	time: string;
	by: MarkSource;
	state: BuoyState;
}

export interface BuoyFile {
	version: number;
	/** The chapter, relative to the story folder. */
	chapter: string;
	/** Oldest first. */
	marks: Mark[];
}

export const BUOY_VERSION = 1;
/** Relative to the story folder; a chapter's file is its path below this, with `.json` added. */
export const BUOY_FOLDER = '.novel-helper/buoys';
const ANCHOR_CHARS = 30;

export function buoyPath(chapter: string): string {
	return `${BUOY_FOLDER}/${chapter}.json`;
}

export function serializeBuoyFile(file: BuoyFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

function isState(value: unknown): value is BuoyState {
	const state = value as BuoyState;
	return (
		typeof value === 'object' &&
		value !== null &&
		['in', 'bridge', 'parallel'].includes(state.kind) &&
		Array.isArray(state.nodes) &&
		state.nodes.length === (state.kind === 'in' ? 1 : 2) &&
		state.nodes.every((ref) => typeof ref?.id === 'string' && typeof ref.title === 'string')
	);
}

/** What a chapter's buoy file holds; undefined for text that is not one. Marks that cannot be read are left out. */
export function parseBuoyFile(text: string): BuoyFile | undefined {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	const file = data as BuoyFile;
	if (typeof data !== 'object' || data === null || typeof file.version !== 'number' || typeof file.chapter !== 'string' || !Array.isArray(file.marks)) {
		return undefined;
	}
	const marks = file.marks.filter(
		(mark) => typeof mark?.at === 'number' && typeof mark.before === 'string' && typeof mark.chars === 'number' && isState(mark.state),
	);
	return { version: file.version, chapter: file.chapter, marks };
}

/** Buoys with their nodes found in the outline as it is now. */
export interface Position {
	kind: BuoyKind;
	nodes: OutlineNode[];
}

export function stateOf(position: Position): BuoyState {
	return { kind: position.kind, nodes: position.nodes.map((node) => ({ id: node.id, title: node.title })) };
}

/**
 * The node a buoy was put on: by its id; or, when the heading was moved
 * within its file, by its title there. A node that has been given
 * sub-headings since stands for its first leaf. Undefined when it is gone.
 */
function find(graph: OutlineGraph, ref: BuoyRef): OutlineNode | undefined {
	let node = graph.nodes.get(ref.id);
	if (!node && ref.id.includes('#')) {
		const file = ref.id.slice(0, ref.id.indexOf('#'));
		const named = [...graph.nodes.values()].filter((one) => one.kind === 'heading' && one.file === file && one.title === ref.title);
		node = named.length === 1 ? named[0] : undefined;
	}
	return node && firstLeaf(node);
}

/** Undefined when a node of the state is no longer in the outline: the buoys are lost. */
export function resolve(graph: OutlineGraph, state: BuoyState): Position | undefined {
	const nodes = state.nodes.map((ref) => find(graph, ref));
	if (nodes.some((node) => node === undefined || !graph.leaves.includes(node))) {
		return undefined;
	}
	return normalize({ kind: state.kind, nodes: nodes as OutlineNode[] });
}

/** Two buoys on the same node are one. */
function normalize(position: Position): Position {
	return position.kind !== 'in' && position.nodes[0] === position.nodes[1] ? { kind: 'in', nodes: [position.nodes[0]] } : position;
}

export function inNode(node: OutlineNode): Position {
	return { kind: 'in', nodes: [firstLeaf(node)] };
}

/** On the way from the first buoy to `node`; with no buoy yet, in `node`. */
export function bridgeTo(position: Position | undefined, node: OutlineNode): Position {
	return position ? normalize({ kind: 'bridge', nodes: [position.nodes[0], firstLeaf(node)] }) : inNode(node);
}

/** The first buoy and `node` at once; with no buoy yet, in `node`. */
export function parallelWith(position: Position | undefined, node: OutlineNode): Position {
	return position ? normalize({ kind: 'parallel', nodes: [position.nodes[0], firstLeaf(node)] }) : inNode(node);
}

/**
 * Where a chapter that has no mark and no text yet starts: where the
 * chapter before it ended; else the first leaf of the outline file that
 * goes with the chapter by its path. Undefined when neither is there.
 */
export function initialPosition(graph: OutlineGraph, previous: BuoyState | undefined, mirror: string | undefined): Position | undefined {
	const carried = previous && resolve(graph, previous);
	if (carried) {
		return carried;
	}
	const file = mirror === undefined ? undefined : graph.nodes.get(mirror);
	return file && inNode(file);
}

/**
 * One step along the main line. Forward: into the next leaf; a bridge
 * arrives; two parallel buoys go on to what follows the later one. Back:
 * into the leaf before; a bridge or a pair falls back to its first buoy.
 * Undefined at either end of the outline.
 */
export function step(graph: OutlineGraph, position: Position, direction: 'forward' | 'back'): Position | undefined {
	const [first, second] = position.nodes;
	if (direction === 'back') {
		const previous = waysFrom(graph, first).previous;
		return position.kind === 'in' ? previous && inNode(previous) : inNode(first);
	}
	if (position.kind === 'bridge') {
		return inNode(second);
	}
	const later = second && graph.leaves.indexOf(second) > graph.leaves.indexOf(first) ? second : first;
	const next = waysFrom(graph, later).next;
	return next && inNode(next);
}

/** The node after the buoys on the main line that is not one of them: what the text is heading for. A bridge is already heading for its second buoy. */
export function nextOf(graph: OutlineGraph, position: Position): OutlineNode | undefined {
	return position.kind === 'bridge' ? undefined : step(graph, position, 'forward')?.nodes[0];
}

/**
 * The buoys as they go into the continuation prompt: their nodes, what the
 * first is under (the book aside: its outline goes in whole), and what
 * comes after them.
 */
export function positionSource(graph: OutlineGraph, position: Position): PositionSource {
	const source = (node: OutlineNode): NodeSource => ({ title: node.title, path: node.file, text: node.text });
	const next = nextOf(graph, position);
	return {
		kind: position.kind,
		nodes: position.nodes.map(source),
		above: ancestors(position.nodes[0]).filter((node) => node !== graph.root && (node.file === undefined || node.file !== graph.root.file)).map(source),
		next: next && source(next),
	};
}

/** A mark for `state` at the end of `text` (the whole chapter file); `chars` is the length of its text, frontmatter aside. */
export function markAt(text: string, chars: number, state: BuoyState, by: MarkSource, time: Date): Mark {
	return { at: text.length, before: text.slice(-ANCHOR_CHARS), chars, time: time.toISOString(), by, state };
}

/**
 * Where a mark is in the text as it is now: at its offset if the text
 * before it still reads the same; else after the nearest place that reads
 * like it; else at its offset, or the end of a text that has become shorter.
 */
export function locate(text: string, mark: Pick<Mark, 'at' | 'before'>): number {
	const at = Math.min(mark.at, text.length);
	if (!mark.before || text.slice(0, at).endsWith(mark.before)) {
		return at;
	}
	const earlier = text.lastIndexOf(mark.before, at);
	const later = text.indexOf(mark.before, at);
	if (earlier === -1 && later === -1) {
		return at;
	}
	const nearest = later === -1 || (earlier !== -1 && at - earlier <= later - at) ? earlier : later;
	return nearest + mark.before.length;
}

/** After files were renamed: the same state with the ids of nodes in a renamed file or folder following it. */
export function renameState(state: BuoyState, renames: ReadonlyArray<{ from: string; to: string }>): BuoyState {
	const renamed = (id: string) => {
		for (const { from, to } of renames) {
			if (id === from || id.startsWith(`${from}#`) || id.startsWith(`${from}/`)) {
				return to + id.slice(from.length);
			}
		}
		return id;
	};
	return { kind: state.kind, nodes: state.nodes.map((ref) => ({ id: renamed(ref.id), title: ref.title })) };
}

// What the model is asked, and how its answer is read.

/** One thing the model may say about a buoy, and where the buoys are if it does. */
export interface Choice {
	text: string;
	/** Undefined: nothing moves. */
	to?: OutlineNode;
	/** With `to`: on the way there, not in it yet. */
	bridge?: boolean;
}

/**
 * What the model chooses between. The buoys only move along the ways of the
 * graph, one step at a time: stay; start towards a node the current one
 * leads to; be in such a node; fall back to the node before. One list for a
 * single buoy or a bridge; one for each of two parallel buoys.
 */
export function choices(graph: OutlineGraph, position: Position): Choice[][] {
	const [first, second] = position.nodes;
	const name = (node: OutlineNode) => `【${node.title}】`;
	if (position.kind === 'bridge') {
		return [
			[
				{ text: `还在从${name(first)}到${name(second)}的衔接里，还没有正式写到${name(second)}的内容` },
				{ text: `已经在写${name(second)}的内容`, to: second },
				{ text: `又回去写${name(first)}的内容了`, to: first },
			],
		];
	}
	return position.nodes.map((node) => {
		const ways = waysFrom(graph, node);
		const onward = [...(ways.next ? [ways.next] : []), ...ways.linked].filter((to) => !position.nodes.includes(to));
		const line = position.kind === 'parallel' ? '这条线' : '';
		return [
			{ text: `${line}还在${name(node)}里` },
			...(position.kind === 'in' ? onward.map((to) => ({ text: `${name(node)}的内容基本写完了，正在写它和${name(to)}之间的衔接`, to, bridge: true })) : []),
			...onward.map((to) => ({ text: `${line}已经在写${name(to)}的内容`, to })),
			...(ways.previous && !position.nodes.includes(ways.previous) ? [{ text: `${line}回头去写${name(ways.previous)}的内容了`, to: ways.previous }] : []),
		];
	});
}

/** The buoys after the model picked one choice from each list. */
export function choose(position: Position, picked: readonly Choice[]): Position {
	if (position.kind === 'parallel') {
		return normalize({ kind: 'parallel', nodes: position.nodes.map((node, i) => picked[i]?.to ?? node) });
	}
	const [choice] = picked;
	if (!choice?.to) {
		return position;
	}
	return choice.bridge ? { kind: 'bridge', nodes: [position.nodes[0], choice.to] } : inNode(choice.to);
}

/** `正文现在写到【A】。`: the buoys in a sentence, for the prompts. */
export function positionLine(kind: BuoyKind, titles: readonly string[]): string {
	const [first, second] = titles.map((title) => `【${title}】`);
	if (kind === 'bridge') {
		return `正文正在从${first}衔接到${second}。`;
	}
	return kind === 'parallel' ? `正文同时在写${first}和${second}。` : `正文现在写到${first}。`;
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}（后略）` : text;
}

function tagged(tag: string, body: string): string {
	return `<${tag}>\n${body}\n</${tag}>`;
}

/** Most of a node's text shown to the model when it judges a move: the buoys' own nodes, the nodes around them. */
const JUDGE_NODE_CHARS = 600;
const JUDGE_NEAR_CHARS = 400;
/** Most of the chapter shown when judging a move, and how much of it from before the last mark. */
export const JUDGE_TEXT_CHARS = 3000;
export const JUDGE_LEAD_CHARS = 300;
/** Most of the chapter's end shown when searching the whole outline. */
export const RELOCATE_TEXT_CHARS = 2000;
const RELOCATE_SUMMARY_CHARS = 40;
/** With more leaves than this, the list has titles only. */
const RELOCATE_SUMMARY_LEAVES = 200;
/** Enough for `A12 B3`. */
export const ANSWER_TOKENS = 16;

export const JUDGE_INSTRUCTIONS = `你在帮一位小说作者记录写作进度：正文现在写到了大纲的哪个节点。大纲是一张图，位置只能沿着图上的连线挪动，每次最多挪一步。

你会看到：当前位置、当前节点和沿连线相邻的节点的内容、最近写的正文，以及几个编号的选项。根据正文实际写到的内容，选出符合的那个选项。

判断方法：
1. 看最近的正文在写哪个节点的内容。只是提到、铺垫或预告了后面的节点，不算写到那个节点。
2. 当前节点的内容还没写完，或者拿不准，就选「还在」的那一项：位置晚一点挪没有关系，挪错了才麻烦。
3. 只回答选项的编号，不要解释，不要输出别的内容。`;

export interface PromptText {
	system: string;
	user: string;
}

/**
 * Asks whether the buoys moved. `text` is the chapter from a little before
 * the last mark to its end; `cutBefore` says that it does not start where
 * the chapter starts.
 */
export function judgePrompt(position: Position, lists: readonly Choice[][], text: string, cutBefore: boolean): PromptText {
	const near = new Set<OutlineNode>();
	lists.flat().forEach((choice) => choice.to && !position.nodes.includes(choice.to) && near.add(choice.to));
	const block = (node: OutlineNode, role: string, max: number) => `【${node.title}】（${role}）${node.text ? `\n${cut(node.text, max)}` : ''}`;
	const nodes = [
		...position.nodes.map((node) => block(node, '当前', JUDGE_NODE_CHARS)),
		...[...near].map((node) => block(node, '相邻', JUDGE_NEAR_CHARS)),
	];
	let asked: string;
	if (lists.length === 1) {
		asked = `选项：\n${lists[0].map((choice, i) => `${i + 1}. ${choice.text}`).join('\n')}\n\n只回答一个编号。`;
	} else {
		const letters = ['A', 'B'];
		const groups = lists.map((list, g) => `${letters[g]} 线【${position.nodes[g].title}】：\n${list.map((choice, i) => `${letters[g]}${i + 1}. ${choice.text}`).join('\n')}`);
		asked = `选项（两条线各选一个）：\n${groups.join('\n')}\n\n按「A编号 B编号」的格式回答，例如：A1 B2。`;
	}
	const user = [
		tagged('当前位置', positionLine(position.kind, position.nodes.map((node) => node.title))),
		tagged('节点', nodes.join('\n\n')),
		tagged('最近的正文', `${cutBefore ? '（前略）' : ''}${text}`),
		asked,
	].join('\n\n');
	return { system: JUDGE_INSTRUCTIONS, user };
}

/** The choices the answer names, one from each list; where it names none that is there, the first: nothing moves. */
export function readJudgement(answer: string, lists: readonly Choice[][]): Choice[] {
	const pick = (list: readonly Choice[], number: string | undefined) => list[Number(number) - 1] ?? list[0];
	if (lists.length === 1) {
		return [pick(lists[0], /\d+/.exec(answer)?.[0])];
	}
	return lists.map((list, g) => pick(list, new RegExp(`${'AB'[g]}\\s*(\\d+)`, 'i').exec(answer)?.[1]));
}

export const RELOCATE_INSTRUCTIONS = `你在帮一位小说作者确定写作进度：正文现在写到了大纲的哪个节点。

你会看到大纲里全部节点的编号列表（按故事的先后排，带着它所在的上级标题，有的带一行摘要），以及这一章最近写的正文。选出正文末尾正在写的那个节点。

判断方法：
1. 以正文末尾实际在写的内容为准。只是提到、铺垫或预告的节点不算。
2. 正文停在两个节点之间时，选已经写到的那个，不选还没开始写的那个。
3. 只回答一个编号，不要解释，不要输出别的内容。`;

/** Asks which leaf of the whole outline the chapter is in. `text` is the end of the chapter. */
export function relocatePrompt(graph: OutlineGraph, chapter: string, text: string, cutBefore: boolean): PromptText {
	const summaries = graph.leaves.length <= RELOCATE_SUMMARY_LEAVES;
	const list = graph.leaves.map((leaf, i) => {
		const summary = summaries ? leaf.text.split('\n', 1)[0].trim() : '';
		return `${i + 1}. ${trail(leaf)}${summary ? `：${cut(summary, RELOCATE_SUMMARY_CHARS)}` : ''}`;
	});
	const user = [
		tagged('大纲节点', list.join('\n')),
		`<本章正文 文件="${chapter}">\n${cutBefore ? '（前略）' : ''}${text}\n</本章正文>`,
		'正文末尾在写哪个节点？只回答一个编号。',
	].join('\n\n');
	return { system: RELOCATE_INSTRUCTIONS, user };
}

/** The leaf the answer names; undefined when it names none. */
export function readRelocation(answer: string, graph: OutlineGraph): OutlineNode | undefined {
	return graph.leaves[Number(/\d+/.exec(answer)?.[0]) - 1];
}
