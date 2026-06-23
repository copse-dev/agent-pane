---
name: screenshot-validate
description: Validate a UI fix in copse-panel with WebdriverIO Electron e2e screenshots. Use when asked to prove a renderer change works, capture before/after screenshots, or visually evaluate whether a fix landed correctly.
---

# Screenshot validate (copse-panel)

Use this skill to **prove a UI change works** and **judge whether it looks correct**.
Invoke it for any renderer, style, markdown, terminal, diff, tool-card, or screenshot fixture change
that affects pixels in the Electron app. A build or `npm run check` is not sufficient evidence for a
visual change.

## Workflow

1. **Identify what to show** — Which view, state, and edge case (e.g. tool args containing `</pre>`).
2. **Prefer WebdriverIO e2e over VNC** — Do not hand-drive the desktop unless debugging layout.
3. **Seed state** — Add or extend a fixture in `tests/e2e/helpers/seed-config.ts` so the app opens in the target state without a real LLM.
4. **Write a focused spec** under `tests/e2e/` that:
   - Relies on `wdio.conf.ts` to launch Electron (`appEntryPoint: dist/main/index.js`, `--disable-gpu`)
   - Sets mock LLM env in `beforeEach`: `COPSE_PANEL_MOCK_LLM=1`, empty API keys
   - Asserts DOM structure (counts, text, attributes) — not just screenshots.
   - Saves PNGs via `tests/e2e/helpers/screenshot.ts` (`saveAppScreenshot` / `saveElementScreenshot`) so committed reference shots share a fixed 1280×800 `#app` frame; use `browser.saveScreenshot` only when the whole OS window matters.
5. **Run**:
   ```bash
   npm run build
   npm run test:e2e -- --spec tests/e2e/<your-spec>.e2e.ts
   ```
6. **Read the screenshots** — Open the PNG paths from the test and visually inspect layout, labels, and that injected-looking strings stayed plain text.
7. **Evaluate and report** — In your reply, state:
   - **Pass/fail** against the assertions
   - **Visual check** — what you see in each screenshot (structure intact, no stray elements, readable args)
   - **Verdict** — whether the fix worked well or what still looks wrong

If no visual eval is added for a visual change, explain the concrete reason in the PR/test summary
and identify the lower-risk command that still exercised the changed rendering path.

## copse-panel conventions

- Mock LLM: `COPSE_PANEL_MOCK_LLM=1` with empty API keys.
- User data: `~/.config/copse-panel/config.json` (Linux); use `resetUserData()` in tests.
- Existing examples: `tests/e2e/tool-display.e2e.ts`, `tests/e2e/innerhtml-tool-args.e2e.ts`.
- Full CI gate after renderer changes: `npm run check && npm run build && npm run test:e2e`.

## Example evaluation (innerHTML tool args)

**Good:** Tool card shows "Write file"; expanded Arguments `<pre>` contains the literal string `</pre>`; no `<img>` nodes inside the card; card chrome (summary, result) still present.

**Bad:** Missing `<pre>`, truncated JSON, extra DOM nodes from args content, or layout collapsed / overlapping text.
