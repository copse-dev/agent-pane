# Browser-hosted renderer spike (#986)

**Status:** technically viable; runner-scale flake claim still unproven.

This spike implements the smallest end-to-end slice of the plan in
[#986](https://github.com/copse-dev/agent-pane/pull/986): build the production renderer for an
ordinary browser, install a mock `ApiClient`, and run representative geometry tests in headless
Chrome without Electron.

## What the spike proves

- `npm run build:demo` produces a static `dist/demo/` without building the main process, preload, or
  other Electron entry points.
- `src/renderer/demo/main.ts` is the only alternate entry seam. It installs the demo API before it
  imports the unchanged production renderer.
- The demo API is assigned directly to `ApiClient`, so adding or changing an API member breaks the
  web typecheck until the mock is updated.
- `?scenario=markdown-list-indent` and `?scenario=footer-compact` load deterministic in-memory
  projects and threads.
- The composer works through the real renderer controller. The mock decodes the existing
  `AgentRunPayload` with `parseAgentRunPayload` and emits `agent.onChunk` events.
- `npm run test:demo` serves `dist/demo/` locally and runs two WebdriverIO Chrome workers in
  parallel. It checks computed geometry and saves deterministic screenshots.

No renderer view or stylesheet was changed for the spike.

## Local results

Measured on 2026-07-17 with macOS and Chrome 150:

| Run                           | Result                           | Wall time reported by WebdriverIO |
| ----------------------------- | -------------------------------- | --------------------------------- |
| Demo build                    | passed                           | about 3 seconds                   |
| Demo suite, one run           | 2 specs / 3 tests passed         | about 4–6 seconds                 |
| Demo suite, repeated 10 times | 10/10 suites; 30/30 tests passed | about 54 seconds total            |
| Equivalent Electron specs     | 2 specs / 3 tests passed         | about 13 seconds                  |

The local comparison is directionally good: the two browser specs execute concurrently and the
suite completed roughly 2–3× faster than the sequential Electron pair. It is not evidence that the
self-hosted lifecycle/OOM failures are fixed; this machine is not the constrained runner class and
ten repetitions are too few to estimate a low flake rate.

## Visual evaluation

- `demo-spike-markdown-list-indent.png`: the real application chrome, conversation, composer, and
  markdown styles render in Chrome. Both headings are followed by sibling lists, bullets are
  consistently indented, and list rows are compact.
- `demo-spike-footer-compact.png`: at a 360px chat width the real responsive footer hides export and
  token text, preserves model/branch context, and keeps the context wheel visible.

The screenshots contain only fixed fixture data. No clock, host path, live git state, or provider
response is rendered.

## Findings and boundaries

1. The single `window.api` seam is sufficient. Dynamic-importing the existing renderer after the
   browser API is installed avoids any production-renderer fork.
2. Type completeness is useful but does not prevent semantic drift. The first interactive check
   exposed one example: `agent.run` receives serialized `AgentRunPayload`, not the visible prompt.
   Reusing `parseAgentRunPayload` fixed that without duplicating host semantics.
3. WebdriverIO's ordinary Chrome support needs no second test framework. On a fresh machine it may
   download the browser-compatible driver, so CI should either permit that download or prewarm the
   WebDriver cache.
4. The test harness needs a loopback HTTP server. Sandboxes that prohibit `listen(2)` must explicitly
   allow that local bind; this is harness infrastructure, not application network access.
5. This tier can test browser layout and event-driven renderer behavior over fixtures. It cannot
   validate Electron `<webview>`, native menus/window chrome, preload IPC, real filesystem/git, pty,
   or process lifecycle behavior.

## Recommendation

Keep the demo build and browser test harness, but do not migrate Electron specs based on this local
sample alone. The next decision gate should run these same two specs at least a few hundred times on
the constrained self-hosted runner used by Electron e2e and compare:

- session-start failures and retries;
- peak RSS and disk use per shard;
- assertion/screenshot variance;
- median and p95 wall time.

If that run stays green and materially reduces lifecycle failures, move geometry-only specs in
small groups. M1's shared fixture extraction and scenario picker should land before a public demo
gallery so the browser and Electron fixtures cannot silently diverge.
