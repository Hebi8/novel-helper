# Changelog

## 0.3.2 (2026-11-12)

Fixes from a review of 0.3.0 and 0.3.1. Where it is not certain that a file can be rewritten or renamed without loss, nothing is touched and you are told why.

- Renaming a volume, arc or chapter no longer takes along an outline or summary folder (or file) that another volume or chapter uses too: then nothing is renamed. A level named like the one it is in is renamed in full instead of failing half-way.
- Setting always-on, aliases or the type no longer breaks frontmatter written as `{…}` or drops a comment inside the value it replaces; what cannot be changed in place is left alone.
- A `..` in the folder and book names of the settings can no longer make initializing, creating or renaming write outside the story folder, and a lore type is no longer followed out of the templates folder. Paths are checked as written; symbolic links are not resolved.
- Templates: a `$` in a name is kept, and names are filled into the frontmatter as YAML values.
- Usage: a window that was slow while holding the lock no longer overwrites what the window that took over wrote; ghost text switched off while a request waited for the usage file is no longer sent.
- Story folder: "Back to the workspace folder" works when a setting further up names another folder; story folders are found even with many markers in build output; a marker made or removed outside VS Code shows without a reload; a story folder without a marker reads "in use"; an index dropped while loading leaves no file watchers behind.

## 0.3.1 (2026-11-12)

- The story can live in a sub-folder: `novelHelper.files.storyFolder` (a path inside the workspace folder; empty is the folder itself). Everything works from there; the **Story folder** row in the sidebar switches it.
- Initializing asks where the story goes and whether its folders get Chinese or English names, and leaves a marker (`.novel-helper/project.json`) by which initialized story folders are found and offered when the current one cannot be used. Folders set up before work as they did, without a marker.

## 0.3.0 (2026-11-12)

- A sidebar: a Novel Helper icon in the activity bar with three views. It lays out the structure and changes the fixed fields; the content is written in the Markdown files it opens.
- **Book**: the book, its volumes, arcs and chapters as a tree that follows the chapter being edited. Every node shows whether it has an outline and a summary, and opens them (creating a missing one where it belongs). New chapters are suggested the next number in the pattern of the ones before (`第12章 ` after `第11章 雾里来信`, `第十二章` after `第十一章`); new volumes and arcs start with their first chapter. Renaming a volume, arc or chapter renames its outline, its summary and the folders that mirror it in one undoable step.
- **Lore**: entries grouped by type, with always-on and aliases on each line. Buttons toggle always-on, edit aliases and change the type by rewriting that one frontmatter field and nothing else in the file. New entries start from a template per type; a workspace can bring its own in `.novel-helper/templates/`.
- **Settings and Usage**: ghost text on or off, trigger, provider, model, whether an API key is saved (never the key), today's and this month's requests and estimated cost, the daily limit, the last request. New commands for the palette: Select Provider, Set Model, Set Daily Limit, Switch Between Automatic and Manual Trigger.
- **Initialize Novel Workspace**: offered in an empty folder; creates the folders, an outline of the whole book, an always-on style entry and optionally a first volume, whichever you tick. Nothing that exists is overwritten.
- Fixed: two windows recording usage at the same moment could lose one of the two requests. Adding to the usage file now happens under a lock file shared by all windows.
- Fixed: an automatic request could still go out after the daily limit was reached, when another window had spent up to it or this one did while the request was waiting. The shared usage is read again right before an automatic request is sent.
- Fixed: once the gray text was showing, typing on or switching ghost text off no longer closed a connection that was still open waiting for the usage (up to 2 seconds, OpenAI-compatible providers). It closes at once again.

## 0.2.0 (2026-11-12)

- Outlines at every level: folders under the chapters folder are levels (volume, arc, as deep as you like), and a chapter's request carries the outline of the whole book (`大纲/全书.md`), of each level above it (the file named after the level's folder) and of the chapter. Each has its own size cap; names in the outlines above the chapter do not pull in lore. Flat workspaces work as before.
- An outline or summary now pairs with a chapter only from the same folders or fewer: `大纲/卷一/第1章.md` no longer serves `正文/卷二/第1章.md`.
- Usage and cost: the tokens each request used (full price, read from cache, written to cache, output) and their estimated cost, in "Show Last Request to the Model"; today's totals on the status bar item; "Show Usage and Estimated Cost" for today and this month per provider and model. Prices of the default models are built in, `novelHelper.usage.prices` adds or overrides them, and `novelHelper.usage.dailyLimitUsd` stops automatic requests once a day's estimated cost reaches it.
- Much more of each request is billed at the cache price. The chapter is sent from its start instead of as a 1,500-character window, lore comes before it in order of first mention, and cache breakpoints follow the text as it grows, so a request repeats the one before it up to the piece being written. `novelHelper.context.beforeChars` is now the most chapter text sent (6,000 by default) and `novelHelper.context.scanChars` is gone.
- OpenAI: requests mark explicit cache breakpoints. Without them, GPT-5.6 and later write the whole prompt to the cache on every request and read none of it back.
- OpenAI-compatible endpoints are asked to report usage, and a request that already has its sentence stays open for up to 2 seconds to receive it (not for local models).
- Renaming or deleting files in the explorer re-indexes the folder, so a renamed volume folder is picked up.

## 0.1.0 (2026-11-11)

First version.

- Ghost-text continuation in Markdown and plain text: one sentence after a pause at a line end in chapter files, or on Alt+\ anywhere; Tab accepts.
- Each request carries the text around the cursor, lore entries named nearby or in the chapter outline (longest match, ranked by closeness and frequency, within a character budget), always-on entries, the chapter outline, and summaries or endings of previous chapters.
- Providers: Anthropic Messages API and OpenAI-compatible Chat Completions (OpenAI, DeepSeek, Gemini, local models), streamed and closed as soon as the first sentence is complete. Keys live in VS Code secret storage.
- "Show Last Request to the Model": the entries used and left out, the full prompt, the raw reply and timings.
- Lore cards on hover, F12 / Alt+F12 to the lore file, re-indexed when files change.
- English and Chinese interface.
