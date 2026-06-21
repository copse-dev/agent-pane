---
name: on-machine-eval
description: >-
  Validate an open copse-panel PR on-machine with build, focused WDIO e2e, and
  screenshots; fold results into the feature branch (not a stacked validate PR).
  Use when asked to visually validate a PR, prove a UI fix on macOS/Linux, or
  run on-machine eval before merge.
---

# On-machine PR eval (copse-panel)

Prove a **feature PR** works on a real machine, then **commit into that branch** — do not open a separate “validate” PR unless the user asks.

## Pick a target

1. Open PR with an **unchecked test plan**, renderer/UI change, or terminal/agent surface.
2. Check out the **feature branch** (`gh pr view <n> --json headRefName`).
3. Skip stacked validate PRs — merge their commits into the feature branch instead.

## Which harness?

| Change type | Skill / command |
|-------------|-----------------|
| DOM, panels, diffs, terminal, picker | [`screenshot-validate`](../screenshot-validate/SKILL.md) |
| Agent loops, tool order, steering | [`agent-run-eval`](../agent-run-eval/SKILL.md) |
| Pure logic | `npm run check` only |

## UI eval loop (most PRs)

1. **Seed** — Extend `tests/e2e/helpers/seed-config.ts` so the app opens in target state (no real LLM).
2. **Spec** — Add `tests/e2e/<feature>.e2e.ts`:
   - DOM assertions first, then `browser.saveScreenshot(...)` → `tests/e2e/screenshots/`
   - Mock env: `COPSE_PANEL_MOCK_LLM=1`, empty API keys (WDIO sets these; repeat for manual runs).
3. **Drive tools without a model** — User message `[[mcp:write_file {"path":"…","content":"…"}]]` (mock honors this on the **current user turn only**).
4. **Run**:
   ```bash
   npm run build
   npm run test:e2e -- --spec tests/e2e/<feature>.e2e.ts
   ```
5. **Read PNGs** — Visually confirm layout, labels, no spawn errors / red errors.
6. **Fix** on the feature branch if assertions or screenshots fail; re-run until pass.
7. **Gate** — `npm run check` before push.

## Report template

```markdown
## On-machine eval — PR #N

**Verdict:** pass / fail

| Check | Result |
|-------|--------|
| `npm run check` | … |
| Focused e2e | … |

**Visual:** (what each screenshot shows)

**Fixes pushed:** (if any)
```

## After validation

- **Push to the feature branch**; update PR test plan checkboxes in the description.
- **Close** any obsolete validate PR with a comment pointing at the feature PR commit.
- **Do not** leave conflict markers in `package.json` after merging `main`.

## CI gotchas (ubuntu-latest)

- Unit tests need **`rg`** on PATH (installed in CI workflow).
- **`npm run test:e2e:ci`** is Linux smoke (`tool-display` only); run full specs locally for renderer work.
- Electron session timeouts on Linux ≠ macOS pass — trust local screenshots for UI proof.

## Examples in repo

- `tests/e2e/staged-diff-ui.e2e.ts` — diff queue + model picker
- `tests/e2e/terminal-display.e2e.ts` — integrated terminal PTY
- `tests/e2e/todo-display.e2e.ts` — inline todo + Plan tab
- `tests/e2e/mermaid-diagram.e2e.ts` — composer layout (`#input-bar` bottom, not `.prompt-input`)
