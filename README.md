# Novel Helper

[中文说明](README.zh-CN.md)

Ghost-text continuation for writing fiction in VS Code that reads your lore. Pause at the end of a line in a chapter and a short continuation appears in gray (up to 100 characters by default, over several paragraphs if it takes them); **Tab** takes it. Each request carries what the scene needs: the chapter so far, the lore entries for names that appear in it, entries you marked always-on (style rules, world basics), the outlines from the whole book down to this chapter, and the summaries or endings of the previous chapters. What it costs in tokens and dollars is always on view.

Lore is one key away too: hover a name to see its card, press **F12** to open its file.

Built for long Chinese web novels first (one chapter per file, hundreds of chapters, no spaces between words) and works for any language. You bring your own API key: Anthropic, OpenAI, DeepSeek, Gemini, or any OpenAI-compatible endpoint such as a local model.

## Install

1. Build `novel-helper-0.3.4.vsix` (see [Build from source](#build-from-source)).
2. In VS Code: Extensions view → `⋯` → **Install from VSIX…**, or run `code --install-extension novel-helper-0.3.4.vsix`. In a Remote-SSH window, install it from that window so it runs next to your files.

## Set an API key

1. Command Palette → **Novel Helper: Set or Clear API Key** → pick the provider → paste the key.
2. For a provider other than Anthropic, set `novelHelper.provider`.

Both can also be done by clicking through **Settings and Usage** in [the sidebar](#the-sidebar).

The key is kept in VS Code's secret storage (the system keychain), never in settings. To remove it, run the same command and submit an empty box.

| Provider | `novelHelper.provider` | Default model | Thinking |
|---|---|---|---|
| Anthropic | `anthropic` | `claude-haiku-5-5` | turned off: `"thinking": {"type": "disabled"}` |
| OpenAI | `openai` | `gpt-6-luna` | turned off: `"reasoning_effort": "none"` |
| DeepSeek | `deepseek` | `deepseek-flash` | turned off: `"thinking": {"type": "disabled"}` |
| Gemini (OpenAI-compatible endpoint) | `gemini` | `gemini-3.5-flash-lite` | Gemini 3 cannot turn it off; this model defaults to `minimal` |
| Local model or other OpenAI-compatible endpoint | `openaiCompatible` | set `novelHelper.openaiCompatible.model` | as the server does |

Workspace settings for the provider, model, base URL, `extraRequestBody`, prices and the daily limit apply only once you trust the folder; in Restricted Mode they come from your user settings, so an untrusted folder cannot redirect your text or key, or lift your spending limit.

Pick another model with `novelHelper.<provider>.model`. When a model needs different request fields, put them in `novelHelper.extraRequestBody`; they are merged into every request, and `null` removes a field. For example, Claude Sonnet 5.5 rejects `disabled` and turns thinking off like this:

```json
"novelHelper.anthropic.model": "claude-sonnet-5-5",
"novelHelper.extraRequestBody": { "thinking": { "type": "between_tools" } }
```

For Ollama, set `novelHelper.provider` to `openaiCompatible` and `novelHelper.openaiCompatible.model` to the model name; the default base URL `http://localhost:11434/v1` already points at it. No key is needed.

The OpenAI provider marks cache breakpoints the way GPT-5.6 and later expect (see [What it costs](#what-it-costs)). Earlier OpenAI models do not take those fields: use `openaiCompatible` with the base URL `https://api.openai.com/v1` for them.

## The sidebar

The activity bar has a Novel Helper icon with five views: the four below, and the [assistant](#the-assistant). The sidebar lays out the structure and changes the fixed fields; the content is always written in the Markdown file it opens.

**Book**: book → volume → arc → chapter, as one tree: the chapters folder as it is (in a flat workspace the chapters sit right under the book).

- Click a chapter to open it; the chapter being edited is selected in the tree.
- Every node says whether it has an outline and a summary: `outline ✓ · summary ✗`. The inline buttons open its outline (and, for a chapter, its summary); one that is missing is first created, empty, where it belongs. The book node at the top opens the outline of the whole book.
- **New Chapter** suggests the next number in the pattern of the chapters before it: `第12章 ` after `第11章 雾里来信`, `第十二章` after `第十一章`, `Chapter 10 - ` after `Chapter 9 - Fog`; add the title and press Enter. **New Volume or Arc** asks for its name and then for the name of its first chapter (a volume is a folder that holds chapters, so it shows up once it has one).
- **Rename** in the context menu of a volume, arc or chapter renames its outline and summary with it, and the folders of that name in the outline and summary folders: one step, and Undo takes it back. When a folder or file that would go along is used from elsewhere too (same-named arcs of two volumes sharing one outline folder, say), nothing is renamed, not one file is touched, and you are told what is shared by whom; give each its own first, or rename by hand.
- There is no delete and no drag and drop; delete and move files in the Explorer and the tree follows.

**Outline**: the folders, files and headings of the outline folder as a tree, with the links between nodes and the node the current chapter is in; the buoys are moved here. See [The outline as a graph](#the-outline-as-a-graph-and-where-a-chapter-is-on-it).

**Lore**: entries grouped by type (`type` in the frontmatter; without one, the top folder the file is in).

- Click an entry to open it. Its line says whether it is always on and what its aliases are.
- Inline buttons toggle always-on and edit the aliases; the context menu also changes the type. Each changes that one frontmatter field and nothing else in the file: other fields, their order, comments and the body stay as they are. A file without frontmatter gets one. Where the way the frontmatter is written does not allow that (all of it in `{…}` without the field, or a comment inside the value to be replaced), the file is left alone and you are told to change it in the file.
- **New Lore Entry**: pick a type (or type a new one), give a name, and the file is made from a template and opened. Templates hold the frontmatter to fill in and two or three headings. To use your own, put `.novel-helper/templates/<type>.md` in the workspace (`人物.md`, say), and `default.md` for every other type; `{{name}}` and `{{type}}` in it are replaced (inside the frontmatter as YAML values, so a name with a colon or brackets is fine).

**Settings and Usage**: one row each, click to change: [the story folder](#the-story-folder), ghost text on or off, automatic or manual trigger, provider, model, API key (shown only as saved or not set, never the key), today's and this month's requests and estimated cost (click for the details), the daily limit, and what was last sent to the model.

**Starting a book**: in an empty folder the sidebar offers **Initialize Here** (**Initialize Novel Workspace** in the Command Palette). It asks where the story goes and whether its folders get Chinese or English names (see [The story folder](#the-story-folder)), then lists what it can create and you tick what you want: the folders for chapters, outlines, summaries and lore, an outline of the whole book with a few labels to fill in, an always-on style entry, and optionally a first volume (`正文/第一卷/第1章.md` and `大纲/第一卷.md`). What exists is not listed and never overwritten.

## The story folder

The story need not sit at the root of the workspace. `novelHelper.files.storyFolder` is the story folder: a path relative to the workspace folder, empty for the workspace folder itself. The folders for chapters, outlines, summaries and lore, and `.novel-helper/templates/`, are looked for inside it; ghost text, lore cards, the sidebar, creating and renaming all work from there, and files outside it are not chapters. There is no need to edit the setting by hand: click the **Story folder** row at the top of **Settings and Usage** to switch to a story folder that was found, pick one in a folder dialog, type a path, or go back to the workspace folder.

- One story folder is in use per workspace folder at a time; several books are switched between. In a multi-root workspace every folder has its own.
- The path has to stay inside the workspace folder. An absolute path or one with `..` is not followed: the sidebar says so, and nothing outside the workspace is read. When a folder or book name in the `novelHelper.files` settings has a `..` that would put a file outside the story folder, initializing, creating and renaming do nothing and name the path. All of this goes by the text of the path: symbolic links are not resolved.
- Initializing first asks where the story goes (a folder that is not there is made) and whether its folders get Chinese or English names (by default the language VS Code is shown in; `正文, 大纲, 摘要, 设定, 人物, 资料` or `chapters, outlines, summaries, lore, characters, worldbuilding`, and the default settings recognize both), then points the story folder there.

Initializing leaves a marker file, `.novel-helper/project.json`, in the story folder. It holds the format version and the names the story was set up with, nothing else:

```json
{
  "version": 1,
  "language": "zh",
  "folders": { "chapters": "正文", "outlines": "大纲", "summaries": "摘要", "lore": ["设定", "人物", "资料"] },
  "book": "全书"
}
```

That is how an initialized story folder is recognized. What the sidebar shows goes by the state of the story folder:

- **Usable**: it has the marker; or it has none but chapters, outlines or lore are there (set up by an earlier version, or by hand). The trees show as usual. The second kind reads "in use" in the **Story folder** row and is never prompted about; to add the marker, pick **Mark this folder as initialized** from the **Story folder** row.
- **Not initialized**: the folder does not exist, or has nothing in it. The views explain and offer **Initialize Here**.
- **Not usable, with other story folders in the workspace**: they are found by their markers (up to four folders deep, not in `node_modules`, `.git` or other hidden folders) and listed under **Book**; click one to switch the story folder to it.

The [`examples/`](examples) folder of this repository works that way too: open the repository root as the workspace and set the story folder to `examples`.

## Lay out the workspace

Open the folder that holds the novel (or point [the story folder](#the-story-folder) at it). The default layout, all of it adjustable in settings:

```text
my-novel/
├── 设定/        lore, one entry per file (also: 人物/ 角色/ 资料/ 世界观/ lore/ characters/ worldbuilding/)
│   ├── 文风.md
│   └── 雾港.md
├── 人物/
│   └── 林小满.md
├── 正文/        chapters, one per file (also: 章节/ chapters/ manuscript/)
│   └── 第一卷 雾港/                 a volume: one folder level
│       └── 第一幕 来信/             an arc: a folder level inside the volume
│           ├── 第1章 雾里来信.md
│           └── 第2章 灯塔.md
├── 大纲/        (also: 细纲/ outline/ outlines/)
│   ├── 全书.md                      outline of the whole book (also: 总纲.md, book.md)
│   ├── 第一卷 雾港.md               outline of the volume: named after its folder
│   └── 第一卷 雾港/
│       ├── 第一幕 来信.md           outline of the arc: named after its folder
│       └── 第一幕 来信/
│           └── 第2章 灯塔.md        outline of the chapter: named after its file
└── 摘要/        summary of the chapter with the same file name (also: summary/ summaries/)
    └── 第1章 雾里来信.md
```

While you write a chapter, the outline of every level above it goes along: the book, the volume, the arc, the chapter. Two rules cover it:

- **Every folder level under the chapters folder is a level**, as many as you like: chapters right in the folder, volumes only, arcs inside volumes, and further down.
- **An outline has the name of what it outlines and sits at the same place under the outline folder**: a chapter's outline is named after the chapter file, a level's after its folder (`正文/第一卷 雾港/` → `大纲/第一卷 雾港.md`). The whole book's is `全书.md`, right in the outline folder; `novelHelper.files.bookNames` changes the name.

A level without an outline file is skipped; the others are not affected. Outlines and summaries may also sit in fewer folders than the chapter: `大纲/第31章.md` and `摘要/第31章.md` serve `正文/卷二/第31章.md` too, and when both places have one, the one whose folders match wins. A same-named file in another volume is never used (`大纲/卷一/第1章.md` does not pair with `正文/卷二/第1章.md`).

A flat layout, all chapters right in `正文/`, works as before.

A lore entry is a Markdown (or `.txt`) file named after the entry. Frontmatter is optional:

```markdown
---
name: 林小满                 # defaults to the file name
aliases: [小满, 林姑娘]      # also matched in the text
type: 人物                   # free text, shown on the card
always: true                 # sent with every request: style rules, world basics
summary: 十七岁，雾港邮局的送信员……   # sent instead of the text below when present
---
The entry's text. Without a summary, its first 500 characters are sent.
```

Chapters are ordered by path, numbers compared by value: 第2章 before 第10章, 第九章 before 第十二章, 卷二 before 卷十.

## The outline as a graph, and where a chapter is on it

The outline is more than a synopsis per chapter: the whole outline folder is a graph, a chapter has a position on it (its buoys), and a continuation takes the part of the outline that position points at.

**Nodes and their order.** Every folder below the outline folder, every file, and every heading in a file is a node: folders hold files, files hold headings, and the outline file of the whole book is the root. A file and the folder of the same name (`第一卷 雾港.md` and `第一卷 雾港/`) are one node; the file says what the folder is about. A single `# title` at the top of a file is the file's own title, not a node; a file without headings is one node. A node's text is what is written under its heading, up to the next heading.

The nodes with nothing below them (the leaves), in order, are the main line of the story: files by name (numbers by value, as for chapters), headings as written. Each leaf leads to the next. The outline need not mirror the chapters folder: one outline file can cover several chapters, and one chapter can run over several nodes.

**Links.** A line `→ title` on its own in a node (`->` works too) says that the story can go from this node to that one: a branch, a merge, a jump.

```markdown
## 渡海

陆青山不肯摆渡，林小满和陆青说服他。

→ 点灯
→ 第二卷 回潮/第13章#船回来
```

When two nodes have the same title, write `path below the outline folder#title` (with or without the extension); `#title` is a heading in the same file, and of two namesakes the one in the same file is taken. A link that names no node, or more than one, is flagged in the sidebar's **Outline** view. A link to a node that has nodes below it leads to its first leaf; a link written on such a node leaves from its last leaf.

**Buoys.** A chapter has one or two, always on leaves, in one of three states: in a node; on the way from one node to another; in two nodes at once. For a chapter with buoys the request carries: the outline of the whole book, the nodes above the buoy's node, that node itself, the next node on the main line (up to `novelHelper.context.nextNodeChars` characters), and a sentence saying where the text is. Lore is brought in by the names in the buoy's node. A chapter without buoys works as before, by the outline file of its name.

- A chapter that is just starting (under 200 characters) is placed the first time it asks for a continuation, without asking the model: where the chapter before it ended; if that one has no buoys, on the first leaf of the outline file of its own name.
- After that, every time the chapter has grown by 1,000 characters (`novelHelper.position.updateChars`, `0` to turn it off; typed or accepted, it counts the same), the next request for a continuation also asks the model, in the background: still there, starting towards a neighbouring node, in a neighbouring node, or back in the one before. It can move one step along a link, each of two parallel buoys on its own; an answer that cannot be read moves nothing. That continuation does not wait for it and goes by the position as it was.
- A chapter that has text but no buoys (a book taken up half-way), or whose buoy's node was renamed or removed in the outline, has the model search all the leaves once. **Novel Helper: Let the Model Find the Position on the Outline** does that at any time.
- These requests use the continuation's provider and model, the answer is a number, and they have a row of their own in **Show Usage and Estimated Cost**. None is sent while ghost text is off, without a key, or over the daily limit.

**By hand.** The sidebar's **Outline** view shows the nodes as a tree and marks where the current chapter is; clicking a node opens its file at the heading. On a node: put the chapter here, make it what the chapter is on its way to, add it as a second node told at once, take the second away. The view's title bar and the Command Palette have one step forward, one step back, and letting the model find the position. A position set by hand stands, and the automatic updates go on from it. While an outline file has the focus these still mean the chapter you last had open. The status bar item's tooltip has the position too.

Buoys are kept in the story folder under `.novel-helper/buoys/`, one JSON file per chapter (`.novel-helper/buoys/正文/…/第2章 灯塔.md.json`), not in the chapter. Every change adds a mark: how far the text was when the buoys were found to be so; the last mark is where the chapter is now. Renaming a chapter or a volume in the sidebar or the explorer takes these files along, and renaming an outline file updates the nodes they name. Renaming a heading in the outline loses the buoys on it: the Outline view says so, and the model searches for them at the next continuation.

## Write

- Pause at the end of a line in a chapter file: after 750 ms the gray text appears. **Tab** takes it; **Esc** or typing on drops it, and cancels a request still in flight.
- **Alt+\\** asks for a suggestion right away, anywhere in a Markdown or plain-text file.
- The status bar item shows on, off and requesting; click it to switch. Set `novelHelper.trigger` to `manual` to ask only with Alt+\\.
- A suggestion is at most 100 characters (`novelHelper.maxSuggestionChars`; punctuation, line breaks and indents count), in as many sentences and paragraphs as fit. The model may stop earlier, at a natural pause after a sentence. Text that runs past the limit is cut after the last 。！？… within it (with any closing quotes after it), and at the limit itself only when there is no sentence end before it.
- Paragraphs are written the way the chapter writes them: a blank line between them or just a line break, a full-width indent at their start or none. That is read from the text before the cursor and applied to what the model wrote. When the line before the cursor is finished (it ends a sentence or with a colon, or it is a heading), a suggestion may begin with a new paragraph.
- The prompt asks for the story to move on with every suggestion. With a position on the outline ([buoys](#the-outline-as-a-graph-and-where-a-chapter-is-on-it)): write on through the node the chapter is in, pass on to the next node when it is done, and do not jump past that one. Without buoys, with a chapter outline: work out which of its points the text has reached and head for the next one, without rewriting what is written or jumping far ahead. Without one: bring something new each time (action, dialogue, information, a change in the situation) and do not restate what the text already said. Nothing may contradict the lore, and key facts the lore does not have (rules of the world, a character's background and relations) are not made up; where the plot goes and the small details of a scene are the model's to write.
- Replies that talk about the task ("好的，以下是续写：…") are not shown.
- While an input method is still composing (pinyin right after Chinese text), no automatic request is sent.

## See what the model was given

Command Palette → **Novel Helper: Show Last Request to the Model** opens a read-only page for the last finished request:

- every entry that went in, and why: always-on, or which names matched, how often, how close to the cursor, named in the outline; with its size and whether its summary or text was used;
- entries left out because their budget ran out;
- for each level, the outline file used, how much of it, whether it was cut, and which levels have none; the chapter's position on the outline and the nodes that went in; the previous chapters used, and how much of each;
- what the request used: input tokens at full price, read from cache and written to cache, output tokens, and the cost estimated from the prices;
- the full prompt (cut where the cache breakpoints are), the request parameters (never the key), the model's raw reply, the ghost text it became, and the timing.

When the model ignores something you expected it to know, this page shows whether the name was never found or the budget was full.

## What goes into a request

In this order, the parts that change least first:

1. Instructions and always-on entries.
2. The outlines above the chapter, largest first: the book, the volume, the arc; then the previous chapters (summary, or the chapter's ending when it has none) and this chapter's outline. Each outline above the chapter has its own size cap and is cut beyond it. For a chapter with [buoys](#the-outline-as-a-graph-and-where-a-chapter-is-on-it) this part is: the outline of the book, the nodes above the buoy's node, the previous chapters, and the position (the buoy's node and the node after it). The buoys move about once in a thousand characters, and when they do the cache from this part on starts over once.
3. Entries whose names or aliases appear in this chapter before the cursor or in this chapter's outline (with buoys, in the buoy's node). Each mention counts more the closer it is to the cursor; when the budget runs short the highest-ranked entries stay. Names in the outlines above the chapter do not count, or the book's outline would pull in every character.
4. This chapter from its start to the cursor, and a little after it.

Names are matched longest-first, so 「张三丰」 never counts as 「张三」. Names with Latin letters ignore case and need word boundaries: `Al` does not match inside `Also`.

## What it costs

Writing a chapter takes many requests, and most of each prompt repeats the one before. Providers bill the part of a prompt that starts the same as an earlier request at about a tenth of the price (prompt caching), so the prompt is laid out to make each request the beginning of the next:

- The chapter is sent from its start, not as a window before the cursor: as you write on, nothing before changes. Past `novelHelper.context.beforeChars` (6,000 by default) the chapter loses a third of that from its start at a time, instead of sliding with every character.
- Lore entries come before the text, in the order they first come up in the chapter: a newly mentioned name adds one entry at the end.
- The text is cut at line ends into pieces of about 300 characters. Cache breakpoints go after the outlines and after the last two finished pieces; each request reads up to the previous breakpoint from the cache and writes the newly finished piece to it.

So while you keep writing, the only part of a request billed at full price is the piece being written (a hundred or two characters on average) and the closing instruction; the rest is billed at the cache price. Come back after the cache has expired and the first request writes the whole prompt to the cache again.

| Provider | How the cache is used | Lifetime | Price of the default model (US dollars per million tokens, from the official pricing pages on 2026-11-12) |
|---|---|---|---|
| Anthropic | Breakpoints in the request | 5 minutes, renewed on each hit | Input 0.10, cache write 0.125, cache read 0.01, output 0.50 |
| OpenAI | Breakpoints in the request (GPT-5.6 and later) | 30 minutes | Input 0.10, cache write 0.125, cache read 0.01, output 0.50 |
| DeepSeek | Finds shared beginnings by itself, best effort | Hours to days | Input 0.15, cache hit 0.003, output 0.60; double on weekdays 01:00–04:00 and 06:00–10:00 UTC |
| Gemini | Automatic on the native API; not documented for the OpenAI-compatible endpoint | | Input 0.30, cached 0.03, output 2.50; has a free tier |

A prompt that is too short is not cached (Anthropic needs 512 tokens, OpenAI 1,024).

**Seeing the usage:**

- Hover the status bar item for today's requests, tokens of each kind and estimated cost.
- Command Palette → **Novel Helper: Show Usage and Estimated Cost** for today and this month, per provider and model, with the share of input read from cache.
- **Show Last Request to the Model** has the usage of the last request.

The counts are what the provider reported for each request. Cost is tokens times price: an estimate, and the provider's bill is what counts. Some details:

- A request cut short by your typing is closed at once. If the provider had reported usage by then, it is counted as usual (Anthropic reports the input side at the start of the stream, so it usually had); if not, the request is counted with its usage unknown.
- When the model stops within the length limit, the stream ends normally and the usage arrives as usual. When its text runs past the limit, ghost text does not wait for the rest. Anthropic reports the input side at the start of the stream, so the connection closes at once and the output count is estimated from the text received, marked as an estimate. OpenAI-compatible endpoints report usage at the very end, so the connection then stays open for up to 2 seconds to get it; if it does not come, the usage is recorded as unknown rather than made up. Local models are not waited for.
- The output cap of a request is two tokens per character of the length limit (200 by default): a Chinese character takes about 0.8 to 1.35 tokens, an English character about 0.25. When the model runs into the cap, the ghost text is cut at its last sentence end.
- With a model other than the default, the extension has no price and counts tokens only. To get a cost, add the price to `novelHelper.usage.prices`:

  ```json
  "novelHelper.usage.prices": {
    "claude-sonnet-5-5": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 2.5 }
  }
  ```

- DeepSeek's peak hours are applied by the clock; Chinese public holidays, which are off-peak, are not accounted for. Gemini is costed at the paid tier, so on the free tier the real cost is zero.
- The totals are kept on the machine the extension runs on (the remote one under Remote-SSH), for this month and the last, and shared by all windows.

**Daily limit:** set `novelHelper.usage.dailyLimitUsd` to a dollar amount and automatic requests stop once the day's estimated cost reaches it; the status bar says so, and **Alt+\\** still asks for one. The default, `0`, is no limit. Requests without a price do not count towards it.

## The assistant

The fifth view in the sidebar, Assistant, is a conversation with an agent that can read and change the whole story folder. Ghost text takes care of the next few lines after the cursor; "tighten the paragraph I selected", "does the outline of volume three still match what is written", "write a summary for this chapter" are things to say here. The view can be dragged to the secondary side bar on the right, next to the editor.

**What to install first**

- Node.js 22 or later. The extension starts the agent's adapter with `npx`; the adapter is not part of the extension and is downloaded on the first start (a few hundred MB, a few minutes). After that it starts from npx's cache in a second or two.
- Claude Code, logged in: run `claude` in a terminal and follow the prompts. The assistant uses the login and the subscription of Claude Code on this machine, not API credit. The extension handles no keys, and the API key for ghost text is not given to the agent. (With `ANTHROPIC_API_KEY` set in the environment, Claude Code bills that key instead, by its own rules.)
- With Remote-SSH the agent runs on the remote machine: Node.js and the login have to be there.

**Choosing the agent**

| `novelHelper.assistant.agent` | |
|---|---|
| `claude` (default) | Claude Code, through the adapter `@agentclientprotocol/claude-agent-acp`. The version is fixed in the extension (0.106.0 now) and moves with the extension's releases: the adapter is released often and is still 0.x, `npx` runs whatever it gets, and what it runs can reach all of your files; a fixed version also starts straight from the cache without asking the registry for a newer one. |
| `custom` | Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdin and stdout: the command goes in `novelHelper.assistant.command`, its arguments in `novelHelper.assistant.args`. Gemini CLI, for example, is the command `gemini` with the arguments `["--acp"]`. Other agents have not been tried one by one; how well they work is up to them. |

These settings are read from your user settings only (remote settings in a remote window), not from a workspace: opening a folder does not let it decide which command is run. In Restricted Mode (a folder you have not trusted) the assistant is off.

**What it knows**

- At the start of every conversation the extension gives it a brief on the workspace: how the folder is laid out (with the folder names this book uses), how outlines and summaries pair with chapters, the frontmatter fields of lore entries, and what it may change.
- Every message takes along the file you have open, the line the cursor is on, and the selected text with its place; the line above the input box says what goes with the next one. So "this paragraph" and "this chapter" work.
- Before a message is sent, unsaved files of the story folder are saved: Claude Code reads and writes the disk itself, not the editor.

**Permissions**

- Reading, searching and changing files inside the story folder, chapters included, goes through without a question for each.
- Everything else is asked about on the panel, and is not allowed unless you click: running commands, the network, paths outside the story folder, folders in it whose names start with a dot (`.git`, `.vscode`, `.novel-helper`: these hold what tools go by, and the snapshots themselves), and files that snapshots do not hold (not text, or over 5 MB; see below), since a change to those could not be gone back from. A symbolic link counts as the place it points to.
- For Claude Code, the extension puts the session into its ask-every-time mode and applies the rules above. Allow rules you wrote into Claude Code's own settings still come first, and commands Claude Code considers read-only (`ls`, `cat`, `echo` and the like) are not asked about either. A custom agent runs in its own default mode.

**Snapshots and going back**

- Before every turn the extension takes a snapshot of the text files in the story folder, kept in `.novel-helper/snapshots/` of the story folder by content: the same content is stored once. After the turn it reads the folder again and compares, which gives the files the turn added, changed and deleted, however the agent wrote them.
- The end of each turn lists the files it changed. Click a file to see the difference in VS Code's diff editor; while the file is still as the turn left it, the right side is the file itself and can be edited there.
- **Go Back to Before This Turn** puts every file that changed since the turn began back as it was then: files made since are deleted, deleted ones come back, and what you changed by hand after the turn goes back too. It asks first, and it takes a snapshot of the story as it is now before doing anything, so going back can itself be undone (**Undo This Going Back**). Files with unsaved edits are saved first, into that snapshot.
- A new conversation clears the panel and keeps the snapshots: **Novel Helper: Assistant: Go Back to Before a Turn…** in the Command Palette lists all that are kept.
- The last 50 are kept (`novelHelper.assistant.snapshots.keep`); older ones are removed, with the contents nothing refers to any more. A turn that changed no file leaves none.
- Not in a snapshot: `.novel-helper/snapshots/` itself, `.git` and `node_modules` folders anywhere, files over 5 MB, files that are not text (a NUL byte in the first 8000 bytes), symbolic links. Changes to those are not listed, and going back leaves them alone. Going back does not delete folders that became empty.
- Snapshots do not use git and do not touch a git repository of yours. `.novel-helper/snapshots/` holds a `.gitignore` containing `*`, so a story kept in git does not commit them.
- When the agent changes a file that has unsaved edits of yours, the editor keeps your version, the panel says so, and VS Code asks which one to keep when you save. Files without unsaved edits are reloaded by VS Code itself.

```text
.novel-helper/snapshots/
├── .gitignore
├── objects/
│   ├── 2d/2cc7a1…          the content of a file, named by its SHA-256
│   └── 47/2d6086…
└── turns/
    ├── 000012.json          a turn: the hash of every file before it, and what it changed
    └── 000013.json          a going back, in the same format
```

**Conversations**

- A conversation lasts while the window is open. A window that is opened again shows it; where the agent can pick the session up (Claude Code can), it goes on, and where not, the panel says that this is a new one.
- When the agent's process ends in the middle, the panel says so, and the next message starts it again and picks the session up.
- **+** in the view's title bar starts a new conversation. **Stop** ends the turn that is running; permission requests still open count as not allowed.
- When the agent cannot be started, the panel says which case it is and what to do: `npx` not found, the agent not logged in, or the process ending right away (with what it wrote last). What the agent writes to stderr is in the Output panel under Novel Helper.

## Look up lore

- Hover a name or alias in any Markdown or plain-text file to see its card. With the cursor on the name, **Ctrl+K Ctrl+I** shows it without the mouse.
- **F12** opens the lore file; **Alt+F12** (Linux: **Ctrl+Shift+F10**) opens it inline, ready to edit.
- Saving, adding, renaming or deleting a lore file takes effect right away.

## Settings

| Setting | Default | |
|---|---|---|
| `novelHelper.enabled` | `true` | Ghost text on or off; the status bar item switches it |
| `novelHelper.trigger` | `auto` | `auto`: after a pause at a line end in chapter files, plus Alt+\\ anywhere; `manual`: Alt+\\ only |
| `novelHelper.debounceMs` | `750` | Pause after typing before a request, in ms |
| `novelHelper.maxSuggestionChars` | `100` | Longest suggestion, in characters (it may span paragraphs) |
| `novelHelper.provider` | `anthropic` | `anthropic`, `openai`, `deepseek`, `gemini`, `openaiCompatible` |
| `novelHelper.anthropic.model` | `claude-haiku-5-5` | |
| `novelHelper.openai.model` | `gpt-6-luna` | |
| `novelHelper.deepseek.model` | `deepseek-flash` | |
| `novelHelper.gemini.model` | `gemini-3.5-flash-lite` | |
| `novelHelper.openaiCompatible.baseUrl` | `http://localhost:11434/v1` | Up to `/v1` |
| `novelHelper.openaiCompatible.model` | | |
| `novelHelper.extraRequestBody` | `{}` | Merged into every request body; `null` removes a field |
| `novelHelper.usage.prices` | `{}` | Your own prices by model id, in US dollars per million tokens |
| `novelHelper.usage.dailyLimitUsd` | `0` | Stop automatic requests once the day's estimated cost reaches this; `0` for no limit |
| `novelHelper.assistant.agent` | `claude` | The agent behind the [assistant](#the-assistant): `claude` or `custom`; user settings only |
| `novelHelper.assistant.command` | | The command that starts a custom agent; user settings only |
| `novelHelper.assistant.args` | `[]` | Arguments of the custom agent's command; user settings only |
| `novelHelper.assistant.snapshots.keep` | `50` | How many of the assistant's snapshots are kept |
| `novelHelper.files.storyFolder` | | [The story folder](#the-story-folder), as a path relative to the workspace folder; empty is the workspace folder itself |
| `novelHelper.files.lore` | `{设定,人物,角色,资料,世界观,lore,characters,worldbuilding}/**/*.{md,txt}` | Globs relative to the story folder |
| `novelHelper.files.chapters` | `{正文,章节,chapters,manuscript}/**/*.{md,txt}` | |
| `novelHelper.files.outlines` | `{大纲,细纲,outline,outlines}/**/*.{md,txt}` | |
| `novelHelper.files.summaries` | `{摘要,summary,summaries}/**/*.{md,txt}` | |
| `novelHelper.files.bookNames` | `全书`, `总纲`, `book` | File names (without extension) of the whole book's outline |
| `novelHelper.context.beforeChars` | `6000` | Most of this chapter before the cursor sent to the model; names are searched in it |
| `novelHelper.context.afterChars` | `200` | Text after the cursor sent to the model |
| `novelHelper.context.alwaysChars` | `1500` | Budget for always-on entries |
| `novelHelper.context.matchedChars` | `2500` | Budget for matched entries |
| `novelHelper.context.entryChars` | `500` | Most taken from one entry |
| `novelHelper.context.bookOutlineChars` | `1000` | Most taken from the whole book's outline |
| `novelHelper.context.levelOutlineChars` | `800` | Most taken from the outline of each level in between (volume, arc) |
| `novelHelper.context.outlineChars` | `800` | Most taken from this chapter's outline; with buoys, from each node the chapter is in |
| `novelHelper.context.nextNodeChars` | `300` | With buoys: most taken from the node that comes next |
| `novelHelper.position.updateChars` | `1000` | Characters a chapter grows by before the model is asked again where it is on the outline; `0` turns the automatic updates off |
| `novelHelper.context.previousChapters` | `3` | Previous chapters included |
| `novelHelper.context.previousChapterChars` | `400` | Most taken from each previous chapter |

Sizes are in characters; one Chinese character counts as one. The `files` and `context` settings can differ per workspace folder. `novelHelper.context.scanChars` from 0.1.0 is gone: names are now searched in all of the chapter text that is sent.

## Try the example

1. Open the [`examples/`](examples) folder of this repository as a workspace and set a key. Click the Novel Helper icon in the activity bar to see the book and the lore as trees.
2. Open `正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md`, put the cursor at the end of the last line and wait for the gray text. In the **Outline** view this chapter is in 「周伯收信」 (the example comes with its buoy file, `.novel-helper/buoys/…`).
3. Run **Show Last Request to the Model** to see what went in: the outline of the book, the two nodes above (「第一卷 雾港」, 「第一幕 来信」), the position 「周伯收信」 and the next node 「商量渡海」; 「陆青山」 matched as itself, not as 「陆青」. Put the chapter back in 「等门」 and ask again: 潮汐钟 now comes in because that node names it (the text only has the bell ringing).
4. Ask for another suggestion, then run **Show Usage and Estimated Cost** to see how much of the second request's input was read from cache.

第1章 has a summary and 第2章 does not: create `第3章.md` in the same folder and its request carries the end of 第2章 instead, and it starts where 第2章 is on the outline, in 「周伯收信」.

## Build from source

```sh
npm install
npm test
npx @vscode/vsce package
```

`npm test` runs the unit tests with Node's test runner; they cover matching, chapter ordering, the story folder's path and state, the marker file, pairing outlines with levels, budgets, prompt assembly and cache breakpoints, the outline graph (nodes, order, links), buoys (states, marks, moving along links, the prompts that ask the model and reading its answers), cutting ghost text and its paragraphs, usage and cost, several windows recording usage at once, what the sidebar relies on (the next chapter's name, rewriting one frontmatter field, which paths a rename moves, lore groups and templates, what initializing creates), the model client against a local fake server, and the extension as a whole, run in a temporary folder against a stand-in for the `vscode` module (renaming, initializing, paths that lead out, lore fields, the story folder, switching ghost text off during a wait, where a chapter starts on the outline, the automatic updates, moving the buoys by hand, and following a rename). For the assistant: taking, comparing, going back to and pruning snapshots, the workspace brief and what goes with a message, the rules for what goes through unasked, folding session updates into the panel's list, and the panel's Markdown reader; the ACP client is tested against a fake agent run as a child process (`src/test/fakeAgent.ts`), and the panel as a whole runs against it in the `vscode` stand-in.

## License

[MIT](LICENSE)
