---
name: screenshot-validate
description: Validate a Copse UI change with focused browser or Electron tests and screenshots. Use to prove a renderer fix, capture visual evidence, or investigate recurring screenshot differences. For accepting existing PR candidates, use pr-screenshot-review.
---

# Screenshot validate

Prove the changed behavior and inspect its appearance. Read `AGENTS.md`,
`docs/testing-strategy.md`, `docs/agent-development.md` (Visual validation), and `docs/ui-taste.md`
from the repository root. Record the visible acceptance criteria before editing.
A build, passing assertions, or a manual VNC glance alone is not visual evidence.

## Choose the smallest useful harness

- Use unit/component tests for logic, DOM structure, and events.
- Use `tests/demo/*.demo.ts` for deterministic renderer geometry and computed styles over the
  in-memory API. See `tests/demo/footer-compact.demo.ts` for assertions and screenshot capture.
- Use `tests/e2e/*.e2e.ts` for native sizing, Monaco, terminal, webview, or real main-process IPC.
- Use [agent-run-eval](../agent-run-eval/SKILL.md) when the claim depends on real agent behavior.
  A deterministic mock tool scenario can validate UI plumbing without proving model quality.

A visible change still needs a focused browser/Electron capture even when component tests cover
its behavior. Reuse an existing focused spec where possible; do not duplicate broad e2e coverage.

## Capture and inspect

1. Identify the state, changed behavior, and relevant edge cases. Seed deterministic state using
   the selected harness. For Electron use `tests/e2e/helpers/seed-config.ts` and `writeSeedConfig`
   so threads reach the native thread store. Do not add test-only product APIs.
2. Assert the behavior first: text, structure, visibility, or geometry. Wait for the specific state
   rather than adding arbitrary delays. Mask/mock live values at the fixture boundary without
   hiding the UI under test. For tool interactions use `installMockScenario` from
   `tests/e2e/helpers/mock-scenario.ts`; release or cancel controlled holds before completion.
3. Capture with `saveAppScreenshot` / `saveElementScreenshot` from
   `tests/e2e/helpers/screenshot.ts`. These own app framing and device scale; the standard viewport
   is 1280×800 CSS pixels at device scale 2, with a wider helper for three-pane views.
   Use raw `browser.saveScreenshot` only when the whole window is the subject.
4. Run the selected tier with Node 24+ and pnpm:

   ```bash
   # Browser geometry
   pnpm run build:demo
   pnpm run test:demo -- --spec tests/demo/<your-spec>.demo.ts

   # Electron: prefer an available configured remote host
   pnpm run build
   pnpm run e2e:remote -- run --spec tests/e2e/<your-spec>.e2e.ts --detach
   pnpm run e2e:remote -- wait <run-id>

   # Local fallback, or platform-specific behavior
   pnpm run test:e2e -- --spec tests/e2e/<your-spec>.e2e.ts
   ```

   Follow `ci-runners/README.md` for remote setup. Local Electron uses the runner's headless/Xvfb
   handling; set `COPSE_E2E_HEADLESS=0` only for an intentionally visible run with a display.
   Use the existing mock configuration (`COPSE_PANEL_MOCK_LLM=1`, empty model API keys) for
   deterministic Electron scenarios; do not change the daily app's settings.

5. Open every resulting PNG from `tests/e2e/screenshots/` or
   `.tmp/remote-e2e/runs/<run-id>/`. Compare before/after, inspect the changed region and surrounding
   UI, and name what is visible. Check clipping, wrapping, missing controls, spacing, and errors.
   Preserve pre-existing user edits when the capture writes reference paths.
6. If it fails, fix the product or fixture cause and rerun the focused spec. Use the test oracle and
   `AGENTS.md` to select the remaining validation gates before committing; do not substitute the
   capture for static/unit checks.

## Profile and reference ownership

The normal profile lives under `~/.copse/` (`COPSE_DIR` relocates it); app state is in
`user-data/config.json` and threads are under `workspace/<projectId>/<threadId>/`.
Let the test harness isolate state and use its reset/seed helpers. Do not edit the daily profile.

A captured PNG is evidence, not automatic permission to replace a reference. Committed references
use CI Linux renders. Never overwrite them with local macOS captures. Use
[pr-screenshot-review](../pr-screenshot-review/SKILL.md) to classify and accept candidates; unrelated
rendering drift does not belong in a feature PR. Do not use `--apply-screenshots` as blanket approval.

For recurring differences follow
[the triage procedure](../../../docs/agent-development.md#triage-a-recurring-candidate-before-re-baselining).
Compare dimensions, measure with pixelmatch, and inspect both images. Live values, unsettled async
UI, and font/environment variation need an explained cause. Never raise ignore thresholds or
re-baseline repeatedly to hide instability or a real regression.

## Report

State the acceptance criteria, exact commands and results, artifact paths, what each image shows,
and a pass/fail/partial verdict. Distinguish mock UI evidence from real-model behavior, local
platform evidence from CI baselines, and completed checks from remaining gaps. If visual evidence
is unavailable, name the concrete blocker; do not claim a visual pass.
