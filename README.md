# Novel Helper

[中文说明](README.zh-CN.md)

Ghost-text continuation for writing fiction in VS Code that reads your lore. Pause at the end of a line in a chapter and a one-sentence continuation appears in gray; **Tab** takes it. Each request carries what the scene needs: the text around the cursor, the lore entries for names that appear nearby, entries you marked always-on (style rules, world basics), this chapter's outline, and the summaries or endings of the previous chapters.

Lore is one key away too: hover a name to see its card, press **F12** to open its file.

Built for long Chinese web novels first (one chapter per file, hundreds of chapters, no spaces between words) and works for any language. You bring your own API key: Anthropic, OpenAI, DeepSeek, Gemini, or any OpenAI-compatible endpoint such as a local model.

## Install

1. Build `novel-helper-0.1.0.vsix` (see [Build from source](#build-from-source)).
2. In VS Code: Extensions view → `⋯` → **Install from VSIX…**, or run `code --install-extension novel-helper-0.1.0.vsix`. In a Remote-SSH window, install it from that window so it runs next to your files.

## Set an API key

1. Command Palette → **Novel Helper: Set or Clear API Key** → pick the provider → paste the key.
2. For a provider other than Anthropic, set `novelHelper.provider`.

The key is kept in VS Code's secret storage (the system keychain), never in settings. To remove it, run the same command and submit an empty box.

| Provider | `novelHelper.provider` | Default model | Thinking |
|---|---|---|---|
| Anthropic | `anthropic` | `claude-haiku-5-5` | turned off: `"thinking": {"type": "disabled"}` |
| OpenAI | `openai` | `gpt-6-luna` | turned off: `"reasoning_effort": "none"` |
| DeepSeek | `deepseek` | `deepseek-flash` | turned off: `"thinking": {"type": "disabled"}` |
| Gemini (OpenAI-compatible endpoint) | `gemini` | `gemini-3.5-flash-lite` | Gemini 3 cannot turn it off; this model defaults to `minimal` |
| Local model or other OpenAI-compatible endpoint | `openaiCompatible` | set `novelHelper.openaiCompatible.model` | as the server does |

Workspace settings for the provider, model, base URL and `extraRequestBody` apply only once you trust the folder; in Restricted Mode they come from your user settings, so an untrusted folder cannot redirect your text or key.

Pick another model with `novelHelper.<provider>.model`. When a model needs different request fields, put them in `novelHelper.extraRequestBody`; they are merged into every request, and `null` removes a field. For example, Claude Sonnet 5.5 rejects `disabled` and turns thinking off like this:

```json
"novelHelper.anthropic.model": "claude-sonnet-5-5",
"novelHelper.extraRequestBody": { "thinking": { "type": "between_tools" } }
```

For Ollama, set `novelHelper.provider` to `openaiCompatible` and `novelHelper.openaiCompatible.model` to the model name; the default base URL `http://localhost:11434/v1` already points at it. No key is needed.

## Lay out the workspace

Open the folder that holds the novel. The default layout, all of it adjustable in settings:

```text
my-novel/
├── 设定/        lore, one entry per file (also: 人物/ 角色/ 资料/ 世界观/ lore/ characters/ worldbuilding/)
│   ├── 文风.md
│   └── 雾港.md
├── 人物/
│   └── 林小满.md
├── 正文/        chapters, one per file (also: 章节/ chapters/ manuscript/)
│   ├── 第1章 雾里来信.md
│   └── 第2章 灯塔.md
├── 大纲/        outline of the chapter with the same file name (also: 细纲/ outline/ outlines/)
│   └── 第2章 灯塔.md
└── 摘要/        summary of the chapter with the same file name (also: summary/ summaries/)
    └── 第1章 雾里来信.md
```

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

Chapters are ordered by path, numbers compared by value: 第2章 before 第10章, 第九章 before 第十二章, 卷二 before 卷十. With volumes in subfolders, outlines and summaries can mirror them (`大纲/卷二/第1章.md` pairs with `正文/卷二/第1章.md`).

## Write

- Pause at the end of a line in a chapter file: after 750 ms the gray text appears. **Tab** takes it; **Esc** or typing on drops it, and cancels a request still in flight.
- **Alt+\\** asks for a suggestion right away, anywhere in a Markdown or plain-text file.
- The status bar item shows on, off and requesting; click it to switch. Set `novelHelper.trigger` to `manual` to ask only with Alt+\\.
- A suggestion is one sentence: it ends at the first 。！？… (with any closing quotes after it), 60 characters at most. Replies that talk about the task ("好的，以下是续写：…") are not shown.
- While an input method is still composing (pinyin right after Chinese text), no automatic request is sent.

## See what the model was given

Command Palette → **Novel Helper: Show Last Request to the Model** opens a read-only page for the last finished request:

- every entry that went in, and why: always-on, or which names matched, how often, how close to the cursor, named in the outline; with its size and whether its summary or text was used;
- entries left out because their budget ran out;
- the outline and previous chapters used, and how much of each;
- the full prompt, the request parameters (never the key), the model's raw reply, the ghost text it became, and the timing.

When the model ignores something you expected it to know, this page shows whether the name was never found or the budget was full.

## What goes into a request

In this order, so the parts that change least come first and providers that cache prompt prefixes can reuse them (Anthropic through a cache breakpoint; OpenAI, DeepSeek and Gemini automatically):

1. Instructions and always-on entries.
2. Previous chapters (summary, or the chapter's ending when it has none) and this chapter's outline.
3. Entries whose names or aliases appear in the last 3,000 characters before the cursor or in the outline. Each mention counts more the closer it is to the cursor; the highest-ranked entries go in until the budget is used.
4. The text before the cursor, and a little after it.

Names are matched longest-first, so 「张三丰」 never counts as 「张三」. Names with Latin letters ignore case and need word boundaries: `Al` does not match inside `Also`.

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
| `novelHelper.maxSuggestionChars` | `60` | Longest suggestion |
| `novelHelper.provider` | `anthropic` | `anthropic`, `openai`, `deepseek`, `gemini`, `openaiCompatible` |
| `novelHelper.anthropic.model` | `claude-haiku-5-5` | |
| `novelHelper.openai.model` | `gpt-6-luna` | |
| `novelHelper.deepseek.model` | `deepseek-flash` | |
| `novelHelper.gemini.model` | `gemini-3.5-flash-lite` | |
| `novelHelper.openaiCompatible.baseUrl` | `http://localhost:11434/v1` | Up to `/v1` |
| `novelHelper.openaiCompatible.model` | | |
| `novelHelper.extraRequestBody` | `{}` | Merged into every request body; `null` removes a field |
| `novelHelper.files.lore` | `{设定,人物,角色,资料,世界观,lore,characters,worldbuilding}/**/*.{md,txt}` | Globs relative to the workspace folder |
| `novelHelper.files.chapters` | `{正文,章节,chapters,manuscript}/**/*.{md,txt}` | |
| `novelHelper.files.outlines` | `{大纲,细纲,outline,outlines}/**/*.{md,txt}` | |
| `novelHelper.files.summaries` | `{摘要,summary,summaries}/**/*.{md,txt}` | |
| `novelHelper.context.beforeChars` | `1500` | Text before the cursor sent to the model |
| `novelHelper.context.afterChars` | `200` | Text after the cursor sent to the model |
| `novelHelper.context.scanChars` | `3000` | Text before the cursor searched for names |
| `novelHelper.context.alwaysChars` | `1500` | Budget for always-on entries |
| `novelHelper.context.matchedChars` | `2500` | Budget for matched entries |
| `novelHelper.context.entryChars` | `500` | Most taken from one entry |
| `novelHelper.context.outlineChars` | `800` | Most taken from this chapter's outline |
| `novelHelper.context.previousChapters` | `3` | Previous chapters included |
| `novelHelper.context.previousChapterChars` | `400` | Most taken from each previous chapter |

Sizes are in characters; one Chinese character counts as one. The `files` and `context` settings can differ per workspace folder.

## Try the example

1. Open the [`examples/`](examples) folder of this repository as a workspace and set a key.
2. Open `正文/第2章 灯塔.md`, put the cursor at the end of the last line and wait for the gray text.
3. Run **Show Last Request to the Model** to see what went in: 「陆青山」 matched as itself, not as 「陆青」, and 潮汐钟 came in through the outline.

第1章 has a summary and 第2章 does not: create `正文/第3章.md` and its request carries the end of 第2章 instead.

## Build from source

```sh
npm install
npm test
npx @vscode/vsce package
```

`npm test` runs the unit tests with Node's test runner; they cover matching, chapter ordering, budgets, prompt assembly, sentence cutting, and the model client against a local fake server.

## License

[MIT](LICENSE)
