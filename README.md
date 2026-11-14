# Novel Helper for Mac

[简体中文](README.zh-CN.md)

A macOS writing space for long fiction, built with Electron, React and CodeMirror 6. A book is a folder of Markdown and text files. Ghost text continues from the cursor with the book's lore, characters, outlines and previous chapters in context. The sidebars keep reference material and an ACP assistant beside the manuscript.

The interface is in Chinese. The VS Code extension remains on the [`vscode-extension`](https://github.com/Hebi8/novel-helper/tree/vscode-extension) branch. Books use the same file formats in both applications.

## Run from source

On an Apple Silicon Mac, install Node.js 22 or later, then:

```sh
npm ci
npm run dev
```


```sh
npm run check
npm test
npm run build
npm run e2e
npm run pack
```

`pack` produces an unsigned arm64 application at `release/mac-arm64/Novel Helper.app`, with the default Electron icon. It only builds a directory target: no DMG, notarization or automatic updates.

## Open or create a book

Use **⌘O** or **打开文件夹** to choose a folder. If the folder is not itself a book, marked books within four directory levels are listed for selection. When an unmarked folder contains both book files and marked books below it, the folder itself is listed first alongside those books; it is marked only if selected. An unmarked folder with book files and no marked books below it is marked in place. Otherwise, initialization lets you choose Chinese or English directory names and select the folders and starter files to create. Existing items are omitted and never overwritten.

**新建一本书** on the welcome page uses the same flow. The system folder chooser can create a new folder. Each book has its own window; reopening a book focuses its existing window. The app restores tabs and cursors on launch.

## Writing and navigation

| Action | Shortcut or location |
|---|---|
| Accept / dismiss ghost text | Tab / Esc; typing also dismisses it |
| Accept the first sentence | ⌘→ |
| Request a continuation | ⌥\ |
| New chapter, continuing the numbering | ⌘N, top bar or chapter-tree context menu |
| New volume or nested level, with its first chapter | Chapter-tree context menu |
| Rename a chapter or level with outlines, summaries and buoy records | Chapter-tree context menu |
| Reveal a chapter, outline or lore item in Finder | Its context menu |
| Quick open | ⌘P |
| Find and replace in the current file | ⌘F |
| Literal, case-insensitive book search | ⌘⇧F; total count, first 200 matches, no book-wide replacement |
| Lore card / open lore file / open beside | ⌘I / F12 / ⌥F12 |
| Split / focus | ⌘\ / ⌃⌘F |
| Left sections / toggle left sidebar | ⌘1–3 / ⌘0 |
| Right sections / toggle right sidebar | ⌥⌘1–3 / ⌥⌘0 |
| Focus assistant / stop assistant | ⌘L / ⌘. |
| Settings | ⌘, |

The left sidebar edits chapters, outlines and lore. The right sidebar reads outlines and lore, and holds the assistant. Content is edited as plain Markdown in tabs. Font, size and optional current-line centering are configurable; colors follow the system. Focus mode hides application chrome and restores the previous sidebar state when toggled again. Esc remains available to dismiss ghost text.

Typing pauses save after one second; switching tabs, leaving the window and starting an assistant turn also save. Search and rename save pending edits first. IME composition is respected. External changes reload clean documents; unsaved documents show a conflict with a diff and a choice of versions. Files retain their line endings. Unsupported encoding or mixed line endings stop editing. There is no file deletion, dragging or reorder interface.

See [`docs/ux.md`](docs/ux.md) for the complete behavior and [`docs/layout.html`](docs/layout.html) for the layout.

## Book files

```text
MyBook/
├── chapters/
│   └── Volume 1/
│       ├── Chapter 1.md
│       └── Chapter 2.md
├── outlines/
│   ├── book.md
│   ├── Volume 1.md
│   └── Volume 1/
│       └── Chapter 2.md
├── summaries/
│   └── Chapter 1.md
├── characters/
│   └── Lin.md
└── lore/
    └── Style.md
```

Recognized default folders:

- Chapters: `正文`, `章节`, `chapters`, `manuscript`.
- Outlines: `大纲`, `细纲`, `outline`, `outlines`.
- Summaries: `摘要`, `summary`, `summaries`.
- Lore: `设定`, `人物`, `角色`, `资料`, `世界观`, `lore`, `characters`, `worldbuilding`.

Both `.md` and `.txt` are supported. Each directory beneath the chapter root is a level; levels may nest without a fixed depth. A companion outline has the same name as its chapter or level. Prefer the matching hierarchy, but a shallower outline or summary also matches when unambiguous. The book outline is named `全书`, `总纲` or `book` by default. A missing outline does not block writing. Chapter paths sort naturally, including Arabic and Chinese numbers.

Lore entries use optional YAML frontmatter:

```markdown
---
name: Lin
aliases: [Xiaoman, Miss Lin]
type: Character
always: true
summary: A seventeen-year-old postal worker in the harbor town.
---
The entry's full text goes here.
```

Without `name`, the filename is the name. `aliases` also match mentions. `type` is an author-defined category; without it, the top-level folder supplies the group. `always` includes the entry with every request. `summary` replaces the body in context; otherwise the body is truncated to the configured entry budget. Names use longest matching and English word boundaries. The lore context menu changes only the selected frontmatter field; ambiguous syntax is left untouched.

Optional lore templates live in `.novel-helper/templates/`, named after a type, with `default.md` as the general template. Template fields are `{{name}}` and `{{type}}`.

## Outlines and buoys

Folders, files and headings in the outline directory form a graph. A file and its same-named folder represent the same node. A single leading `# Title` names the file rather than adding a plot node. The remaining headings become nodes in written order. Leaf nodes form the main sequence; files use natural name order.

A standalone line `→ Node title` (or `-> Node title`) adds a connection. Disambiguate with `path#Heading`, with or without the file extension, or use `#Heading` in the same file:

```markdown
## Cross the sea

The two travelers persuade the boatman to help.

→ Light the tower
→ Volume 2/Chapter 13#The boat returns
```

Each chapter has one or two buoys: inside one node, bridging from one to another, or following two in parallel. The right outline panel can place, advance, retreat or relocate them. The last active chapter remains the target while an outline file is being edited.

Buoys are stored in `.novel-helper/buoys/<chapter-path>.json`, with a history of marks; nothing is inserted into the manuscript. Short new chapters inherit the previous chapter's position or begin at their companion outline. By default, after 1,000 net new characters, the next continuation also checks whether the position should move one connected step. Set `position.updateChars` to `0` to disable automatic movement. Lost or uninitialized positions can be relocated. Renaming from the chapter tree moves companion files and rewrites buoy paths and node references together. File renaming uses hard links to avoid overwriting existing files. exFAT and some network volumes do not support them; on these volumes chapter renaming stops without changing files and the app explains why.

Shared companions, destination conflicts, case-only name changes and unreadable records stop the rename before anything moves. If an unexpected error interrupts the moves, the app reports completed and remaining operations and updates tabs to the paths that actually changed; it does not roll back.

Requests include always-on lore, the book and ancestor outlines, previous chapters (summaries when available), current buoy nodes and the next node, matching lore, and text around the cursor. Without buoys, the same-named chapter outline is used. The **续写** menu opens read-only request and usage reports.

## Settings

**⌘,** opens grouped rows for continuation, providers and models, request parameters, context budgets, folder rules, usage, writing preferences, snapshots and the assistant. Numbers and text edit in place. Arrays and objects use JSON in a small dialog; invalid JSON is not saved. Defaults are listed in [`src/shared/defaults.ts`](src/shared/defaults.ts). There is no `files.storyFolder` setting: the selected folder is the book root.

Providers include Anthropic, OpenAI, DeepSeek, Gemini and OpenAI-compatible endpoints. Each provider's API key is entered separately and never displayed. Custom endpoints use `openaiCompatible.baseUrl` and `openaiCompatible.model`; extra request fields use `extraRequestBody`.

`usage.prices` maps model IDs to USD prices per million tokens (`input`, `output`, `cacheRead`, `cacheWrite`). `usage.dailyLimitUsd` is an estimated daily limit: `0` means unlimited. Reaching the limit stops automatic requests; manually requested continuation remains available. Usage without known prices is marked unpriced rather than assumed free. The assistant uses its own account and is outside this ledger.

All settings belong to the application. A book cannot change providers, endpoints, credentials, prices, limits or assistant commands.

## Assistant

Install and log in to Claude Code locally. Node.js 22+ and `npx` must be available. The application starts the official `@agentclientprotocol/claude-agent-acp` adapter through ACP. It does not manage Claude Code's login or give it the continuation API key. The login-shell PATH is loaded when the app starts.

The assistant receives the open file, cursor and selection. When the agent reports model or thought-level options through ACP, a button beside the send button opens a popover to switch the model and effort level and remembers each selection per agent (starting the agent in the background to read options the first time the panel is shown without cached options, and otherwise waiting until the first message), restoring the model before thought level on new or resumed sessions while keeping remembered values untouched if absent from the agent's current list. Permissions beyond permitted book operations appear as **允许这一次** or **不允许**. The preset adapter also loads the book's `.claude` settings: its allow rules and hooks do not pass through the app's permission cards. Inspect that directory before using someone else's book.

Every assistant turn has before/after snapshots, a file list, diffs and a way to revert the entire turn. Reverting writes restored files via same-directory temporary files before renaming, saves the current state first and can itself be undone. Assistant snapshot retention defaults to 50. Custom ACP agents can be configured with `assistant.agent`, `assistant.command` and JSON `assistant.args`. Agent changes apply at its next start.

Manual edits also have timed snapshots under `.novel-helper/snapshots`: once the configured interval (`snapshots.intervalMinutes`, default `10`, `0` disables without scanning or holding a baseline; changing `0` to non-`0` baselines open books from that moment) has elapsed since the book's last snapshot of any kind, file saves and renames schedule a whole-book checkpoint in the background without waiting on the scan (notifying once in the top notice bar on failure), while subsequent book writes and assistant turn snapshots wait for any running baseline or timed scan to finish (retrying a failed baseline before the next write, notifying at most once until built); closing the book, closing the window or quitting also saves one if files changed since the last snapshot and flushes pending snapshots before exit (skipped while an assistant turn is running). Retention defaults to `100` (`snapshots.keep`), counted separately from assistant snapshots, with unchanged files deduplicated by content hash. **快照** in the top bar lists both kinds chronologically with per-file diffs and undoable point-in-time revert, while keeping `.novel-helper/snapshots` compatible with VS Code extension 0.4.0.

## Data and logs

- Manuscripts, lore and outlines stay in the selected book folder.
- `.novel-helper/project.json` marks the book; buoys, templates and snapshots also live under `.novel-helper/`.
- Application settings, window state, shared usage records and per-book assistant conversations live under Electron's application data directory in `~/Library/Application Support/` (`Novel Helper` by default).
- API keys remain encrypted using macOS safe storage backed by the system keychain, in the application data directory.
- Logs are in the application's `logs/` directory. **帮助 → 打开日志** reveals it in Finder.

## License

[MIT](LICENSE). Bundled dependencies and their license texts are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Electron's distribution includes its own license files.
