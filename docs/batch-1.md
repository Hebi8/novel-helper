# Mac app foundation

This worktree starts with `8af4cfc` (the UX and layout documents). The extension remains available as `vscode-extension` at `0167edc`. Version remains `0.4.0`.

## Module boundaries for batches 2 and 3

- Main-process IPC registration is the `features` list in `src/main/register.ts`. Each feature owns its `ipc.ts`; window, book, settings, secrets, completion and usage are already separate.
- `src/main/context.ts` supplies the sender's book, settings, encrypted secrets, window state and completion service. `BookIndex.library` is the unchanged core `Library`. Paths used by the book API are relative to the story root.
- `src/shared/api.ts` defines the narrow preload contract and channel names. `src/preload/index.ts` is the only renderer-to-main bridge. No raw IPC object or Node API is exposed.
- `src/renderer/workspace.tsx` exposes `useWorkspace()` to panels: book, tabs, the active document and selection, `open(path)` and `saveAll()`. A panel does not need to own an editor or change `App.tsx` to open a file or collect the active writing context.
- Batch 2 owns `left/OutlinePanel.tsx`, `left/LorePanel.tsx`, `right/OutlinePanel.tsx`, `right/LorePanel.tsx` and additions to the status bar.
- Batch 3 owns `right/AssistantPanel.tsx`. The conflict strip currently offers only keep-mine/use-disk. A later diff action can be added there.
- UI strings, including menu and search-panel labels, live in `src/renderer/strings.ts`.

## Behavior carried over

Core, LLM, storage and ACP sources are unchanged except for exporting `paragraphStyle` from `core/suggestion.ts`. No position is passed to `buildContext`. The application does not read or update chapter positions. The shared defaults retain the original setting keys as data; settings are read only from application userData.

The main process assembles whole-book, volume, arc and chapter outlines, previous chapters (preferring summaries), and matched/always-present lore through the existing context builder. Automatic requests honor chapter/line-end/manual-mode/daily-limit rules. Manual requests ignore the automatic daily limit. A cached automatic request returns its last answer; a manual request asks again, matching the extension. Cancellation retains the existing client's usage accounting. Window close waits for outstanding usage writes.

The ghost state machine has no DOM dependencies. CodeMirror supplies actual composition events, decorations and single-transaction acceptance. Single-sentence acceptance includes trailing quotes. The editor preserves paragraph spacing as display-only decoration and inserts literal tabs when no higher-priority Tab action applies.

`DocumentModel` owns a per-document save queue. Main-process saves compare the last disk baseline before writing a temporary sibling and renaming it. External dirty-document changes block saves until resolved. A delayed save acknowledgement does not erase a newer conflict. Disk reload starts a fresh editor history.

## Necessary choices

- Window size: 1440 × 900; left/right panels: 250/280 px, based on the supplied layout. Settings: 540 × 430. Content width is at most 720 px after padding.
- Book title is the chosen root folder's name; the tree's whole-book label still comes from `Library`.
- Word count counts Unicode code points other than whitespace, including punctuation and Markdown markers.
- Recent books retain ten entries. Closing a tab does not close its book window.
- File patterns use Node's built-in `path.matchesGlob`, and directory observation uses recursive `fs.watch`; no extra watcher or glob dependency is shipped.
- TypeScript is 6.0.3, the current stable line supported by the installed typescript-eslint version. Its peer range excludes TypeScript 7; peer checks were not bypassed.

## Tests and remaining native acceptance

`npm test` compiles node:test sources and runs them in a system temporary directory. The runner copies `examples`, compiled tests, lockfile and notices there. The unchanged `examples.test.ts` expects the extension's old `contributes.configuration.properties` shape; only its temporary manifest fixture gets that shape, generated from the application's defaults. The shipped package manifest has no extension fields. Original assertions and source files remain unchanged, except the requested `snapshot.test.ts` helper import relocation. `node scripts/notices.cjs` regenerates notices from non-development lockfile packages and their actual LICENSE files. The build copies the notices into `dist/`.

E2E uses a temporary examples copy and userData directory, `--test-mode`, hidden windows, a hidden Dock icon and the existing local fake server. Test mode never decrypts a key or accesses safeStorage encryption. The child launch environment omits the host's `ELECTRON_RUN_AS_NODE`; all other environment variables remain inherited without being read or printed.

On this host, the sandbox denies local server listening and fs.watch, so unit tests are run with approved local test permissions. Electron itself was tried only inside the original sandbox. It exits with SIGABRT before the first window (`Process failed to launch!`); its exit is recorded in the Playwright log. No permission escalation for Electron, `--no-sandbox` flag, or alternate display launch was used. The E2E test remains failing rather than skipped. Native input methods, visual layout, native menus and encrypted-key UI still require a permitted runtime acceptance run. The browser access host was also unavailable when opening the supplied layout; its source was used for the implementation, without claiming a browser visual check.

The E2E flow is implemented in `e2e/writing.spec.ts`: open book, show hierarchy, open chapter 2, request from the fake service at document end, accept with Tab, wait for the exact disk contents, then change the file externally and observe the editor reload. It also checks hidden windows and absence of renderer `require`.

## Recorded validation

- `npm test`: 358 tests, 74 suites, 358 passed, 0 failed, skipped or cancelled. All 23 retained original test files match `0167edc`, with only the permitted snapshot helper import change.
- `npm run check`: exit 0, main/preload/renderer/test/E2E TypeScript and lint.
- `npm run build`: exit 0, main/preload/renderer bundles and third-party notices produced.
- `npm run e2e`: 1 failed at Electron launch; SIGABRT before any window or fake-server request. Native acceptance is outstanding.
- Source/manifest scan: 0 VS Code module or type references. `git diff --check`: clean.

The command output is preserved under `docs/validation/`.
