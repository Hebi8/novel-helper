# Novel Helper for Mac

[简体中文](README.zh-CN.md)

A macOS writing space for long fiction, built with Electron, React and CodeMirror 6. A book is a folder of Markdown and text files. Ghost text continues from the cursor with the book's lore, characters, outlines and previous chapters in context. The sidebars keep reference material and an ACP assistant beside the manuscript.

The interface is in Chinese. The VS Code extension remains on the [`vscode-extension`](https://github.com/Hebi8/novel-helper/tree/vscode-extension) branch. Books use the same file formats in both applications.

## Run from source

On an Apple Silicon Mac, install Node.js 22 or later and Xcode Command Line Tools (`xcode-select --install`), then:

```sh
npm ci
npm run dev
```

The native build step compiles a small macOS file-operation helper. It provides exclusive file creation and an atomic directory exchange for renaming a chapter together with its companion files. Renames require a local volume that supports cloning and atomic exchange, such as APFS. If preparation fails or a destination exists, the original book is left unchanged.

```sh
npm run check
npm test
npm run build
npm run e2e
npm run pack
```

`pack` produces an unsigned arm64 application at `release/mac-arm64/Novel Helper.app`, with the default Electron icon. It only builds a directory target: no DMG, notarization or automatic updates. The tests work on temporary copies of [`examples/`](examples); window tests require a macOS graphical session, and some unit tests require local HTTP servers or file watching.

## Open or create a book

Use **⌘O** or **打开文件夹** to choose a folder. If it contains marked books within four directory levels, choose one from the list. An unmarked folder with recognized book directories is marked in place. Otherwise, initialization lets you choose Chinese or English directory names and select the folders and starter files to create. Existing items are omitted and never overwritten.

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

Buoys are stored in `.novel-helper/buoys/<chapter-path>.json`, with a history of marks; nothing is inserted into the manuscript. Short new chapters inherit the previous chapter's position or begin at their companion outline. By default, after 1,000 net new characters, the next continuation also checks whether the position should move one connected step. Set `position.updateChars` to `0` to disable automatic movement. Lost or uninitialized positions can be relocated. Renaming from the chapter tree moves companion files and rewrites buoy paths and node references together. Shared companions, destination conflicts and unreadable records stop the rename.

Requests include always-on lore, the book and ancestor outlines, previous chapters (summaries when available), current buoy nodes and the next node, matching lore, and text around the cursor. Without buoys, the same-named chapter outline is used. The **续写** menu opens read-only request and usage reports.

## Settings

**⌘,** opens grouped rows for continuation, providers and models, request parameters, context budgets, folder rules, usage, writing preferences and the assistant. Numbers and text edit in place. Arrays and objects use JSON in a small dialog; invalid JSON is not saved. Defaults are listed in [`src/shared/defaults.ts`](src/shared/defaults.ts). There is no `files.storyFolder` setting: the selected folder is the book root.

Providers include Anthropic, OpenAI, DeepSeek, Gemini and OpenAI-compatible endpoints. Each provider's API key is entered separately and never displayed. Custom endpoints use `openaiCompatible.baseUrl` and `openaiCompatible.model`; extra request fields use `extraRequestBody`.

`usage.prices` maps model IDs to USD prices per million tokens (`input`, `output`, `cacheRead`, `cacheWrite`). `usage.dailyLimitUsd` is an estimated daily limit: `0` means unlimited. Reaching the limit stops automatic requests; manually requested continuation remains available. Usage without known prices is marked unpriced rather than assumed free. The assistant uses its own account and is outside this ledger.

All settings belong to the application. A book cannot change providers, endpoints, credentials, prices, limits or assistant commands.

## Assistant

Install and log in to Claude Code locally. Node.js 22+ and `npx` must be available. The application starts the official `@agentclientprotocol/claude-agent-acp` adapter through ACP. It does not manage Claude Code's login or give it the continuation API key. The login-shell PATH is loaded when the app starts.

The assistant receives the open file, cursor and selection. Permissions beyond permitted book operations appear as **允许这一次** or **不允许**. The preset adapter also loads the book's `.claude` settings: its allow rules and hooks do not pass through the app's permission cards. Inspect that directory before using someone else's book.

Every assistant turn has before/after snapshots, a file list, diffs and a way to revert the entire turn. Reverting saves the current state first and can itself be undone. Snapshot retention defaults to 50. These are assistant-turn snapshots; ordinary typing has no periodic snapshots. Custom ACP agents can be configured with `assistant.agent`, `assistant.command` and JSON `assistant.args`. Agent changes apply at its next start.

## Data and logs

- Manuscripts, lore and outlines stay in the selected book folder.
- `.novel-helper/project.json` marks the book; buoys, templates and assistant snapshots also live under `.novel-helper/`.
- Application settings, window state, shared usage records and per-book assistant conversations live under Electron's application data directory in `~/Library/Application Support/` (`Novel Helper` by default).
- API keys remain encrypted using macOS safe storage backed by the system keychain, in the application data directory.
- Logs are in the application's `logs/` directory. **帮助 → 打开日志** reveals it in Finder.

## License

[MIT](LICENSE). Bundled dependencies and their license texts are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Electron's distribution includes its own license files.
