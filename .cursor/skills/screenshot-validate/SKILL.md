---
name: screenshot-validate
description: Validate a UI fix in agent-pane with Playwright Electron e2e screenshots. Use when asked to prove a renderer change works, capture before/after screenshots, or visually evaluate whether a fix landed correctly.
---

# Screenshot validate (agent-pane)

Use this skill to **prove a UI change works** and **judge whether it looks correct**.

## Workflow

1. **Identify what to show** — Which view, state, and edge case (e.g. tool args containing `</pre>`).
2. **Prefer Playwright e2e over VNC** — Do not hand-drive the desktop unless debugging layout.
3. **Seed state** — Add or extend a fixture in `tests/e2e/helpers/seed-config.ts` so the app opens in the target state without a real LLM.
4. **Write a focused spec** under `tests/e2e/` that:
   - Launches Electron: `electron.launch({ args: ['dist/main/index.js', '--disable-gpu'], env: { AGENT_WINDOW_MOCK_LLM: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } })`
   - Asserts DOM structure (counts, text, attributes) — not just screenshots.
   - Saves PNGs to `tests/e2e/screenshots/` with descriptive names.
5. **Run**:
   ```bash
   npm run build
   xvfb-run -a npx playwright test tests/e2e/<your-spec>.ts
   ```
6. **Read the screenshots** — Open the PNG paths from the test and visually inspect layout, labels, and that injected-looking strings stayed plain text.
7. **Evaluate and report** — In your reply, state:
   - **Pass/fail** against the assertions
   - **Visual check** — what you see in each screenshot (structure intact, no stray elements, readable args)
   - **Verdict** — whether the fix worked well or what still looks wrong

## agent-pane conventions

- Mock LLM: `AGENT_WINDOW_MOCK_LLM=1` with empty API keys.
- User data: `~/.config/agent-pane/config.json` (Linux); use `resetUserData()` in tests.
- Existing examples: `tests/e2e/tool-display.spec.ts`, `tests/e2e/innerhtml-tool-args.spec.ts`.
- Full CI gate after renderer changes: `npm run check && npm run build && npm run test:e2e`.

## Example evaluation (innerHTML tool args)

**Good:** Tool card shows "Write file"; expanded Arguments `<pre>` contains the literal string `</pre>`; no `<img>` nodes inside the card; card chrome (summary, result) still present.

**Bad:** Missing `<pre>`, truncated JSON, extra DOM nodes from args content, or layout collapsed / overlapping text.
