# Changelog

## 0.1.0 (2026-11-11)

First version.

- Ghost-text continuation in Markdown and plain text: one sentence after a pause at a line end in chapter files, or on Alt+\ anywhere; Tab accepts.
- Each request carries the text around the cursor, lore entries named nearby or in the chapter outline (longest match, ranked by closeness and frequency, within a character budget), always-on entries, the chapter outline, and summaries or endings of previous chapters.
- Providers: Anthropic Messages API and OpenAI-compatible Chat Completions (OpenAI, DeepSeek, Gemini, local models), streamed and closed as soon as the first sentence is complete. Keys live in VS Code secret storage.
- "Show Last Request to the Model": the entries used and left out, the full prompt, the raw reply and timings.
- Lore cards on hover, F12 / Alt+F12 to the lore file, re-indexed when files change.
- English and Chinese interface.
