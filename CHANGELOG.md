# Changelog

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
