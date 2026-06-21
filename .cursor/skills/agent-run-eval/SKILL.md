---
name: agent-run-eval
description: >-
  Drive copse-panel agent runs with scripted user prompts, capture thread JSONL,
  score tool loops deterministically, and LLM-judge responses. Use when the user
  asks to explore testing an issue, evaluate agent behavior, or review a run export.
---

# Agent run eval (copse-panel)

When the user asks you to **explore testing an issue** or **evaluate agent behavior**, you act as **driver + judge**: you choose user prompts, run the app (or analyze an export), score tool usage, and assess the final answer.

This is separate from `screenshot-validate` (DOM/layout) and from `validate:local-agent` (headless loop with only list_dir/read_file).

## Your role

1. **Clarify the issue** — What behavior should improve? (e.g. todo steering, duplicate explores, diff-first reviews.)
2. **Write a scenario** — JSON under `tests/e2e/scenarios/` with `id`, `prompts[]`, and optional expectations for the analyzer (see below).
3. **Drive the run** — Execute prompts through the real Electron UI + local/cloud model.
4. **Score deterministically** — Run the analyzer on captured JSONL.
5. **Judge qualitatively** — You (the Cursor agent) read the trace + final text and report pass/fail against the issue, gaps, and regressions.

Do not ask the user to manually export JSONL unless driving automation is blocked (no display, LM Studio down, etc.).

## Drive a run (automation)

Prerequisites:

- `npm run build`
- LM Studio (or configured model) running if not using mock
- Display for Electron (local or CI with Xvfb)
- **Quit any dev Copse / `npm run dev` instance** before agent eval (optional if eval isolation works, but two live Copse processes still compete for GPU/memory and confuse debugging)
- Run eval from a shell where **`LM_STUDIO_API_KEY` / `LM_API_TOKEN`** are set if you rely on env (or save the key in Settings)

### Avoid “Copse quit unexpectedly” during eval

| Cause                                                                                                   | Mitigation (built into harness)                                                                                        |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Eval Electron missing `COPSE_PANEL_USER_DATA` → writes same `~/Library/…/copse-panel` as your daily app | `wdio.eval.conf.ts` writes `tests/e2e/electron-shell/.eval-env.json`; `bootstrap.cjs` applies it **before** `app-init` |
| Single-instance lock vs second Copse                                                                    | `COPSE_AGENT_EVAL=1` skips `requestSingleInstanceLock()`                                                               |
| Dozens of MCP stdio servers from `~/.cursor/mcp.json` on startup                                        | MCP load is **skipped** when `COPSE_AGENT_EVAL=1`                                                                      |
| `ELECTRON_RUN_AS_NODE` in agent shells                                                                  | WDIO inherits a normal Electron launch; for manual runs use `env -u ELECTRON_RUN_AS_NODE`                              |

If it still crashes: check Console.app crash log for the eval PID, ensure LM Studio is up for non-mock runs, and retry with `COPSE_EVAL_USE_MOCK=1` to confirm the harness (not the model loop) is stable.

```bash
# Real local model (default for eval wdio config)
npm run test:e2e:agent-eval

# Custom scenario file
COPSE_EVAL_SCENARIO=tests/e2e/scenarios/my-issue.json npm run test:e2e:agent-eval

# Smoke the harness with mock LLM (fast, not for behavior quality)
COPSE_EVAL_USE_MOCK=1 npm run test:e2e:agent-eval
```

The spec prints `COPSE_EVAL_ARTIFACT=/path/to/tests/e2e/artifacts/<id>-<ts>.jsonl`.

On macOS in Cursor’s agent shell, unset `ELECTRON_RUN_AS_NODE` when launching Electron manually; the WDIO wrapper handles this.

## Analyze artifact (deterministic)

```bash
npm run analyze:thread -- tests/e2e/artifacts/<file>.jsonl

# With expectations (exit 1 on violation)
npm run analyze:thread -- tests/e2e/artifacts/<file>.jsonl tests/e2e/scenarios/my-issue.json
```

Optional `expect` block in scenario JSON:

| Field                        | Meaning                                          |
| ---------------------------- | ------------------------------------------------ |
| `shouldSteerTodos`           | User message should match `shouldSteerTodos()`   |
| `requireUpdateTodos`         | At least one `update_todos` tool call            |
| `maxExplore` / `minExplore`  | Explore count bounds                             |
| `requireTools`               | e.g. `["git_diff"]` for review tasks             |
| `forbidTools`                | Tools that should not appear                     |
| `maxInputTokens`             | Token budget guard                               |
| `forbidParallelExploreTurn1` | First assistant turn must not launch 2+ explores |

## LLM judge (you)

After the analyzer JSON, write a short report:

1. **Issue fit** — Did the run address what the user cared about?
2. **Tool loop** — Sensible order? Duplicate explores? Missing git_diff on “review changes”?
3. **Steering vs behavior** — If `shouldSteerTodos` true but no `update_todos`, call that out.
4. **Answer quality** — Factual vs repo, actionable, hallucinations.
5. **Verdict** — Pass / fail / partial; one concrete next change (prompt, heuristic, or product).

Use the user’s exported JSONL from Downloads the same way: `npm run analyze:thread -- ~/Downloads/foo.jsonl` then judge in prose.

## Scenario authoring tips

- **Prompt catalog:** `tests/fixtures/todo-steering-prompts.json` lists prompts that must / must not match `shouldSteerTodos()` (enforced by `src/shared/todos/todo-steering-prompts.test.ts`). Reuse these for agent eval scenarios.
- **Strict todo evals:** `todo-steer-implement-test.json` and `todo-steer-refactor-several-files.json` set `requireUpdateTodos: true` for action prompts. Review/audit scenarios (`todo-steer-deep-dive`, `todo-steer-review-diff`) only assert steering + tool use — todos are optional there.
- One scenario per issue; keep `prompts` short and realistic (what a user would type).
- Multi-turn: add follow-up strings to `prompts` in order; the driver waits for idle between each.
- For “review my diff” issues, set `expect.requireTools: ["git_diff"]`.
- For todo steering issues, set `expect.shouldSteerTodos: true` and optionally `requireUpdateTodos: true` when you want strict compliance.

## When not to use this skill

- Pure UI layout → `screenshot-validate`
- Unit logic only → `npm test`
- Headless “does local model finish with text?” → `npm run validate:local-agent`
