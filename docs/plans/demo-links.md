# Demo links: a browser-hosted renderer build

**Status: Active.** Nothing is on `main` yet; the technical spike is in draft
PR [#989](https://github.com/copse-dev/agent-pane/pull/989).

Build the renderer as a static web page backed by a mock API, so a UI change
can be reviewed as a **shareable demo link** — interactive, both themes, live
streaming playback — rather than only as committed screenshots. The same
artifact opens a second door: a **browser test tier** (wdio + plain headless
Chromium, no Electron) that could absorb most of the "geometry-only" specs
currently pinned to the flaky Electron e2e tier.

## Why this is cheap here

The renderer is already almost web-clean; the audit that motivated this plan
found:

- **One injection point.** The renderer touches Electron through a single
  `const api = window.api` in `src/renderer/main.ts`, typed as one interface —
  `ApiClient` in `src/preload/api.d.ts` (~163 methods / 35 namespaces). Every
  view and controller takes `api` as an argument; it is de-facto dependency
  injection with exactly one seam to swap.
- **No Electron/Node imports** anywhere in `src/renderer` or `src/shared`
  outside test files. Monaco, xterm, mermaid, highlight.js, DOMPurify are all
  browser libraries; Monaco's workers are already built for a browser context
  (`scripts/copy-monaco-workers.mts`).
- **The browser bundle already exists.** `scripts/build.mts` builds the
  renderer with esbuild `platform: 'browser'` into `dist/renderer/` with a
  static `index.html`. The demo build is a variant of this target.
- **The demo content already exists as test fixtures.**
  `tests/e2e/helpers/seed-config.ts` holds ~40 `seedXxxFixture()` builders
  whose thread objects are plain renderer-agnostic JSON (today exploded to
  disk via `src/shared/threads/` for Electron to read). A browser mock can
  serve the same JSON directly — every seeded e2e scenario is a demo state.
- **The scripted-conversation layer ports too.** The declarative
  `when: regex → tool/text` mock scripts (`src/shared/llm/mock-script.ts`)
  and `MockLLMProvider` (`packages/llm/src/mock-provider.ts`) have no Electron
  dependency — today they run in the main process behind
  `COPSE_PANEL_MOCK_LLM=1`, but they can run _inside_ the browser mock, so a
  demo link can accept a prompt and play back a scripted streaming response
  with tool cards and approvals.
- **Hosting exists.** `pages.yml` already deploys `site/` to copse.dev.

## What Electron actually provides (and how the demo stubs it)

- **Browser pane** — `src/renderer/views/browser-pane.ts` uses Electron's
  `<webview>` guest tag, the one genuinely Electron-only renderer feature.
  Demo builds render a placeholder (static screenshot or sandboxed iframe).
- **Terminal** — xterm renders fine in a browser; node-pty is gone. Demo
  replays canned scrollback into xterm.
- **Everything behind IPC** — fs, git, gh, agent loop, sandbox, MCP — is
  mocked. Fine for demos; it means a demo link never _proves_ main-process
  behavior, so those specs stay Electron e2e (see tier boundary below).
- **Window chrome** — native menus, pane popout, titlebar integration behave
  differently or not at all; demo hides or approximates them.

## Design

### M0 — demo build target + mock ApiClient

- `src/renderer/demo/demo-api.ts`: implements `ApiClient` against in-memory
  fixture data. Most of the ~163 methods are no-op stubs; the load-bearing
  ones are `settings.get`, `threads.loadProject`, `storage.*`, `fs.*`,
  `git.status`, and the `agent.*` event streams. The typed interface is the
  completeness check — the build fails until the mock is total.
- `scripts/build.mts` grows a `--demo` variant: same esbuild renderer bundle,
  an entry shim that installs `demo-api` as `window.api` before `boot()`, and
  a self-contained static output (`dist/demo/`) servable from any static host.
- Non-goal: no renderer source changes beyond the entry shim. If a view needs
  patching to tolerate the mock, that's a smell the mock is wrong.

### M1 — shared fixtures + scenario picker

- Extract the fixture _data_ from `tests/e2e/helpers/seed-config.ts` into a
  shared module (`tests/fixtures/` or `src/shared/fixtures/`) consumed by both
  the e2e seeding path (explode to disk, unchanged behavior) and `demo-api`
  (served in-memory).
- A scenario index page: `dist/demo/?scenario=git-changes` selects the seeded
  state; the bare URL lists all scenarios. Theme/layout toggles included —
  one deploy demos dark/light and portrait.

### M2 — interactive playback

- Run `MockLLMProvider` + mock scripts inside `demo-api`'s agent namespace so
  the composer works: typed prompts match `when:` patterns and stream the
  scripted response through the real `agent.onChunk` path. This reuses the
  existing scripts verbatim (e.g. the one in
  `tests/e2e/mock-script-multiturn.e2e.ts`).

### M3 — deploy

- **Main-branch gallery first**: extend `pages.yml` to build `--demo` and
  publish under `copse.dev/demo/`. Trivial, trusted content only.
- **Per-PR previews are deliberately deferred.** GitHub Pages allows one
  deployment per repo, so per-PR means either subdirectory-per-PR rebuilds of
  the whole site, an external preview host (Cloudflare Pages), or a
  downloadable artifact linked from the existing sticky screenshot comment
  (`<!-- copse-e2e-screenshots -->` in `ci.yml`'s `commit-screenshots` job).
  Deploying bundles built from untrusted PR branches to copse.dev is also a
  real security/phishing consideration — decide separately. The artifact link
  is the safe default.

### M4 — browser test tier (wdio, not Playwright)

**Decision: wdio.** The e2e stack is already WebdriverIO (configs, helpers,
spec reporter, expect-webdriverio, CI sharding, the oracle); a second driver
would fork all of that for no capability we need. wdio drives plain headless
Chromium via chromedriver — a new `wdio.demo.conf.ts` with
`browserName: 'chrome'`, headless args, `maxInstances > 1`, and a static
server (or `file://`) serving `dist/demo/`. Specs reuse the existing helper
style; no Electron shell, no Xvfb, no `.e2e-env.json`.

**Spike before migrating anything** — the flake theory is measurable. The
Electron tier's recorded failures are lifecycle ones (runner OOM / disk /
session-startup, per `docs/e2e-component-migration.md`), and the browser tier
boots the heavy thing once per shard instead of per spec. But per-page render
memory and pixel nondeterminism are identical in both. So: port 2–3
quarantined geometry specs (`footer-compact`, `markdown-list-indent`), loop
them a few hundred times on the same self-hosted runner class that OOMs
today, and compare. If they still fall over, the flake is content-level and
the tier buys review UX only — still worth M0–M3, not worth a migration.

**Tier boundary if the spike passes.** The demo tier can absorb e2e-only
specs whose real-runtime need is _geometry/computed style_ (roughly:
`chat-layout-styling`, `footer-compact`, the markdown geometry family,
`mermaid-diagram`, `scroll-to-bottom`, `settings-footer`,
`portrait-right-panel`). Specs needing **real IPC, webview, pty, real
git/fs, or Monaco file workers** stay Electron e2e, as do the live-model
evals (`wdio.eval.conf.ts`). `docs/testing-strategy.md` gains a row:

| Question the test answers              | Tier           |
| -------------------------------------- | -------------- |
| Sizing/geometry over mocked backend    | demo (browser) |
| Monaco / terminal / webview / main IPC | e2e (Electron) |

## Risks

- **Mock drift.** `demo-api` can diverge from real preload semantics (not
  types — the interface enforces those — but behavior: event ordering,
  error shapes). Mitigation: keep the mock thin and data-driven; anything
  behavioral should come from shared code (`MockLLMProvider`, thread fold
  logic), not reimplementation.
- **New-harness teething.** A new tier has its own first-months flake; the
  spike bounds this before anything migrates.
- **Screenshot policy.** If demo-tier specs capture screenshots, all rules in
  `docs/testing-strategy.md` → "Deterministic screenshots" apply unchanged —
  fixtures only, no clocks/randomness.

## Milestone summary

- **M0** demo build target + total mock `ApiClient` — the bulk of the work.
- **M1** shared fixtures + scenario picker page.
- **M2** in-browser mock-script playback (interactive demos).
- **M3** copse.dev/demo gallery from main; per-PR distribution decided
  separately (artifact link is the default).
- **M4** wdio Chromium demo-test config + flake spike; migrate geometry specs
  only if the spike passes.
