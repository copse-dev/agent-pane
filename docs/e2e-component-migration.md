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

## The discriminator

`saveScreenshot` and `browser.reloadSession()` are boilerplate — **no spec
asserts via image snapshot** (zero `toMatchImageSnapshot`), and most fixtures
just seed a `config.json` thread the renderer loads and renders, which reproduces
directly in happy-dom. A spec must **stay e2e** only when its assertion needs a
real runtime:

- **Layout/geometry** — `getBoundingClientRect`, `getComputedStyle`,
  `clientWidth`, `elementFromPoint` (happy-dom/jsdom return zeroed geometry).
- **Monaco** editor (diff, selection, language workers).
- **xterm / node-pty** terminal.
- **webview / browser** panel (Electron webContents).
- **Real IPC to main** — `fs:listDir`, git status/diff, sandbox, project load.

Everything else (DOM structure, classes, text, `data-*` attrs, store wiring,
event handlers, markdown render output) is component-testable.

## Classification (52 specs: 24 component · 6 hybrid · 22 e2e-only)

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

### E2E-ONLY — needs a real Electron/Chromium runtime

chat-layout-styling (geometry) · code-block-copy (computed opacity + clipboard) ·
footer-compact (clientWidth) · markdown-bold-glob · markdown-list-indent ·
markdown-ordered-list-spacing · markdown-table-wrap (all 4: bounding-rect geometry) ·
mermaid-diagram (worker SVG render) · monaco-selection-chat · staged-diff-ui ·
file-open-worker-error (Monaco) · git-changes · git-changes-image (git IPC + Monaco) ·
terminal-display (xterm/pty) · browser-display · browser-link-chat · browser-tools
(webview; low-confidence — tool-card text could decouple) · explorer-reload-spaced-path
(fs IPC) · portrait-right-panel · queued-pinned · scroll-to-bottom · settings-footer
(all: bounding-rect geometry) · agent-eval-drive (real LLM + git)

## Top conversion candidates (do first)

All are already CI-quarantined for flake/OOM yet assert only DOM — biggest
flake/cost reduction:

| #   | Spec                   | Quarantined for               | Unit-test target                                            |
| --- | ---------------------- | ----------------------------- | ----------------------------------------------------------- |
| 1   | new-thread-keeps-panel | new-thread `$$` race          | `controller/panels.ts` + projects-pane _(prototype landed)_ |
| 2   | subagent-display       | runner OOM                    | tool-card / subagent view                                   |
| 3   | context-breakdown      | OOM                           | footer context-breakdown view + store                       |
| 4   | message-queue          | timing                        | message-queue controller                                    |
| 5   | queued-message-edit    | timing                        | message-queue / composer controller                         |
| 6   | queued-send-now        | timing                        | message-queue controller                                    |
| 7   | draft-prompt           | `$$` race + reloadSession OOM | thread-switch draft persistence                             |
| 8   | skills                 | flake                         | composer slash-command controller                           |

(Runner-up: semantic-search-markdown — markdown-renderer structure, once the
trivial indent-geometry line is dropped.)

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

1. Add the component test (mount real views/controllers; assert the same DOM).
2. Confirm it passes locally (`npm test`) and reproduces the e2e's intent.
3. Delete the e2e spec (or, for HYBRID, trim it to the thin integration smoke)
   and drop it from `wdio.ci.conf.ts` `ciExclude` if it was quarantined.
