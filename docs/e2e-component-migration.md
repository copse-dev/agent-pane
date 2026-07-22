# E2E → component-test migration

The e2e tier (`tests/e2e/*.e2e.ts`, wdio + real Electron + Chromedriver, sharded
8× in CI) is slow and flaky — the recurring CI failures are runner OOM / disk
exhaustion / Electron session-startup, not assertion failures. Many specs don't
actually need a real browser engine: the renderer is vanilla DOM/TS over a store,
and there's an established happy-dom/jsdom unit layer (`tests/setup-dom.ts`,
`tests/setup-dom-jsdom.ts`; e.g. `src/renderer/controller/panels.test.ts`,
`src/renderer/views/portrait-right-panel-layout.test.ts`).

Moving a spec down to a component test removes it from the flaky tier entirely
(better than the test-oracle merely skipping it) and it gets exact import-graph
selection. This doc tracks what can move.

## Migrated so far

- `message-queue`, `queued-send-now`, `queued-message-edit` → component (#377).
- `context-breakdown` → `src/renderer/views/context-wheel.test.ts` — the breakdown
  ring (`has-breakdown`, `NN%` label, ≥2 arcs) and hover popover render from a
  `ContextBreakdown` with no Electron; the estimate itself (main IPC) stays e2e,
  so the test feeds the real shared `composeContextBreakdown` builder.
- `tool-display` → `src/renderer/views/tool-display.test.ts` (#386).
- `composer-typing-no-rerender` → `src/renderer/views/conversation-draft-no-rerender.test.ts`
  (the regression — conversation must not rebuild on a draft save — decomposes
  into this view test plus the existing `composer-draft-autosave` /
  `thread-helpers` draft-event units).
- `new-thread-keeps-panel` → component (prototype, see Pattern below).
- Markdown specs (`markdown-bold-glob` / `-ordered-list-spacing`)
  kept fast structural coverage alongside their geometry checks when the renderer lived in this
  repository; those parser contracts now live in the extracted `@copse/streaming-markdown` package.
- `footer-compact` and `markdown-list-indent` → browser-hosted geometry specs in
  `tests/demo/`; they exercise the unchanged renderer without Electron startup or IPC.
- `draft-prompt` → the real projects pane + input bar in `input-bar.test.ts`; draft retention,
  thread switching, composer restoration, and creating a second blank thread are all store/DOM.
- `skills` → slash-picker filtering and insertion in `skill-picker.test.ts`; the Electron spec is
  trimmed to the workspace-skill discovery + live agent invocation seam.
- `semantic-search-markdown` → structural assertions in `subagent-display.test.ts`, with only
  indentation and expanded-preview geometry retained in the browser tier.
- `subagent-display` visual smoke, `settings-footer`, and `chat-layout-styling` → browser-hosted
  scenarios. The latter two remove active Electron sessions from the CI suite; none needs main or
  preload IPC.

## The discriminator

`saveScreenshot` and `browser.reloadSession()` are boilerplate — **no spec
asserts via image snapshot** (zero `toMatchImageSnapshot`), and most fixtures
just seed a `config.json` thread the renderer loads and renders, which reproduces
directly in happy-dom. A spec must **stay e2e** only when its assertion needs a
real runtime:

- **Layout/geometry** — use the browser-hosted tier when deterministic mocked state is sufficient;
  keep Electron only when the geometry depends on native chrome or Electron-only primitives.
- **Monaco** editor (diff, selection, language workers).
- **xterm / node-pty** terminal.
- **webview / browser** panel (Electron webContents).
- **Real IPC to main** — `fs:listDir`, git status/diff, sandbox, project load.

Everything else (DOM structure, classes, text, `data-*` attrs, store wiring,
event handlers, markdown render output) is component-testable.

## Historical classification snapshot

The lists below classify the 52-spec suite as it existed when the migration started. The suite has
grown substantially, so treat this as rationale for the named candidates, not a current inventory;
`npm run check:oracle` is authoritative for the live spec count. Completed entries remain here to
show why they moved.

### COMPONENT — convertible to happy-dom/jsdom

tool-display · innerhtml-tool-args · install-approval · onboarding ·
openrouter-model-picker · settings-model-routing · settings-save · skills ·
smoke · titlebar-workspace · titlebar-icons (computed style props, not geometry) ·
todo-display · subagent-display · message-queue · queued-message-edit ·
queued-send-now · draft-prompt · new-thread-keeps-panel · composer-branch-warning ·
composer-typing-no-rerender · context-breakdown · footer-branch-status
(low-confidence: real-git seed) · semantic-search-markdown (one trivial indent
check, drop it)

### HYBRID — port core to a component test, keep a thin e2e smoke

- **tool-display-live-mock** — static-fixture render is component; keep a 1-line live smoke.
- **double-submit** — port the double-click→single-queue guard to a controller test; keep a live-send smoke.
- **follow-up-suggestions** — render/restore is component; the git-stat bubble needs real git.
- **panel-toggle** — toggle + shortcut routing is component; terminal/changes tabs (pty + git IPC) stay e2e.
- **context-wheel** — seeded static part is component; the live mock-run part stays e2e.
- **markdown-streaming-table** — `is-streaming` class transitions are component; the `getComputedStyle` CSS-transition check stays e2e.

### BROWSER — real geometry over deterministic mocked state

footer-compact (clientWidth) · markdown-list-indent (bounding-rect geometry) ·
semantic-search-markdown (list indentation) · subagent-display (visual reference) ·
settings-footer (sticky-footer geometry) · chat-layout-styling (pane/gradient geometry)

### E2E-ONLY — needs a real Electron/Chromium runtime

code-block-copy (computed opacity + clipboard) ·
markdown-bold-glob · markdown-ordered-list-spacing · markdown-table-wrap
(all 3: bounding-rect geometry) ·
mermaid-diagram (worker SVG render) · monaco-selection-chat · staged-diff-ui ·
file-open-worker-error (Monaco) · git-changes · git-changes-image (git IPC + Monaco) ·
terminal-display (xterm/pty) · browser-display · browser-link-chat · browser-tools
(webview; low-confidence — tool-card text could decouple) · explorer-reload-spaced-path
(fs IPC) · portrait-right-panel · queued-pinned · scroll-to-bottom
(all: bounding-rect geometry) · agent-eval-drive (real LLM + git)

## Top conversion candidates (do first)

All are already CI-quarantined for flake/OOM yet assert only DOM — biggest
flake/cost reduction:

| #   | Spec                   | Quarantined for               | Unit-test target                                            |
| --- | ---------------------- | ----------------------------- | ----------------------------------------------------------- |
| 1   | new-thread-keeps-panel | new-thread `$$` race          | `controller/panels.ts` + projects-pane _(prototype landed)_ |
| 2   | subagent-display ✓     | runner OOM (live-mock half)   | `subagent-display.test.ts` (DOM) + browser visual smoke     |
| 3   | context-breakdown      | OOM                           | footer context-breakdown view + store                       |
| 4   | message-queue          | timing                        | message-queue controller                                    |
| 5   | queued-message-edit    | timing                        | message-queue / composer controller                         |
| 6   | queued-send-now        | timing                        | message-queue controller                                    |
| 7   | draft-prompt ✓         | `$$` race + reloadSession OOM | thread-switch draft persistence                             |
| 8   | skills ✓               | flake                         | composer slash-command controller + thin integration smoke  |

(Runner-up `semantic-search-markdown` is now split between component structure and browser
geometry.)

## Pattern (established by the prototype)

`src/renderer/views/new-thread-keeps-panel.test.ts` ports
`tests/e2e/new-thread-keeps-panel.e2e.ts`: seed a `createStore({...})` with a
project + non-blank thread, mount the **real** `mountProjectsPane` view plus a
`#pane-files` element kept in sync by the panels controller, drive the
`.project-new-thread-btn` click through the real `openNewThread` path, and assert
the same behaviour the e2e did — chat-row count, selected title, `#pane-files`
visibility, and `rightPanelMode === 'explorer'` (what drives the Explorer tab's
`is-active`) — with no Electron. Replicate this shape per candidate.

## Workflow per migration

1. Add the lowest viable replacement: component for DOM/logic, browser-hosted for real geometry.
2. Confirm it passes locally (`npm test` or `npm run build:demo && npm run test:demo`) and
   reproduces the e2e's intent.
3. Delete the Electron spec (or, for HYBRID, trim it to the thin integration smoke)
   and drop it from `wdio.ci.conf.ts` `ciExclude` if it was quarantined.
