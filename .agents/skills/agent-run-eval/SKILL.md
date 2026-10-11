---
name: agent-run-eval
description: >-
  Drive Copse agent runs with scripted user prompts, capture thread JSONL,
  score tool loops deterministically, and LLM-judge responses. Use when the user
  asks to explore testing an issue, evaluate agent behavior, or review a run export.
---

# Agent run eval (Copse)

When the user asks you to **explore testing an issue** or **evaluate agent behavior**, you act as **driver + judge**: you choose user prompts, run the app (or analyze an export), score tool usage, and assess the final answer.

This is separate from `screenshot-validate` (DOM/layout) and from `validate:local-agent` (headless loop with only list_dir/read_file).

Read `AGENTS.md`, `docs/testing-strategy.md`, and `docs/agent-development.md` from the repository
root. Record the behavior and acceptance criteria before running. Use Node 24+ and pnpm.
For authenticated ACP or native GUI reproduction also follow `docs/remote-agent-demo-debugging.md`.

## Your role

1. **Clarify the issue** — What behavior should improve? (e.g. todo steering, duplicate explores, diff-first reviews.)
2. **Write a scenario** — JSON under `tests/e2e/scenarios/` with `id`, `prompts[]`, and optional expectations for the analyzer (see below).
3. **Drive the run** — Execute prompts through the real Electron UI + local/cloud model.
4. **Score deterministically** — Run the analyzer on captured JSONL.
5. **Judge qualitatively** — You (the reviewing agent) read the trace + final text and report pass/fail against the issue, gaps, and regressions.

Do not ask the user to manually export JSONL unless driving automation is blocked (no display, LM Studio down, etc.).

## Drive a run (automation)

Prerequisites:

- `pnpm run build`
- LM Studio (or configured model) running if not using mock
- Let `scripts/run-e2e.mts` manage headless Chromium / Linux Xvfb; a visible run needs a real display.
- Use the harness-isolated profile and scenario workspace; preserve the daily app and unrelated running sessions. Diagnose resource contention before asking to stop them.
- Run eval from a shell where **`LM_STUDIO_API_KEY` / `LM_API_TOKEN`** are set if you rely on env (or save the key in Settings)

### Avoid “Copse quit unexpectedly” during eval

| Cause                                                                                      | Mitigation (built into harness)                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Eval Electron missing `COPSE_PANEL_USER_DATA` → writes daily app profile under `~/.copse/` | `wdio.eval.conf.ts` writes `tests/e2e/electron-shell/.eval-env.json`; `bootstrap.cjs` applies it **before** `app-init` |
| Single-instance lock vs second Copse                                                       | `COPSE_AGENT_EVAL=1` skips `requestSingleInstanceLock()`                                                               |
| Dozens of MCP stdio servers from `~/.cursor/mcp.json` on startup                           | MCP load is **skipped** when `COPSE_AGENT_EVAL=1`                                                                      |
| `ELECTRON_RUN_AS_NODE` in agent shells                                                     | WDIO inherits a normal Electron launch; for manual runs use `env -u ELECTRON_RUN_AS_NODE`                              |

If it still crashes: check Console.app crash log for the eval PID, ensure LM Studio is up for non-mock runs, and retry with `COPSE_EVAL_USE_MOCK=1` to confirm the harness (not the model loop) is stable.

```bash
# Real model (defaults from wdio.eval.conf.ts; select explicitly for reproducible comparisons)
pnpm run test:e2e:agent-eval

# Custom scenario file
COPSE_EVAL_SCENARIO=tests/e2e/scenarios/my-issue.json pnpm run test:e2e:agent-eval

# Smoke the harness with mock LLM (fast, not for behavior quality)
COPSE_EVAL_USE_MOCK=1 pnpm run test:e2e:agent-eval
```

`COPSE_EVAL_MODEL` selects the model, including supported ACP selections; check `wdio.eval.conf.ts`
for current routing and authentication. The harness clears Anthropic/OpenAI API-key variables, so
merely setting those does not configure an eval. For local-server overrides it accepts
`COPSE_EVAL_LOCAL_SERVER_URL` (or `COPSE_EVAL_LM_STUDIO_URL`). Record the selected model/provider,
scenario, commit, and mock/real mode alongside the result. Preserve the requested permission mode;
do not enable Guarded YOLO or broader ACP access just to make an evaluation pass.

The spec prints `COPSE_EVAL_ARTIFACT=/path/to/tests/e2e/artifacts/<id>-<ts>.jsonl`.
WDIO eval user-data/profile directories are removed after the session; set
`COPSE_EVAL_KEEP_WDIO=1` to keep `.wdio-eval-*` directories for crash debugging.

On macOS in an agent shell, unset `ELECTRON_RUN_AS_NODE` when launching Electron manually; the WDIO wrapper handles this.

## Analyze artifact (deterministic)

```bash
pnpm run analyze:thread -- tests/e2e/artifacts/<file>.jsonl

# With expectations (exit 1 on violation)
pnpm run analyze:thread -- tests/e2e/artifacts/<file>.jsonl tests/e2e/scenarios/my-issue.json
```

Optional `expect` block in scenario JSON:

| Field                        | Meaning                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `shouldSteerTodos`           | User message should match `shouldSteerTodos()`                        |
| `requireUpdateTodos`         | At least one `update_todos` tool call                                 |
| `maxExplore` / `minExplore`  | Explore count bounds                                                  |
| `requireTools`               | e.g. `["git_diff"]` for review tasks                                  |
| `requireAnyTools`            | Passes when the run used at least one of these                        |
| `forbidTools`                | Tools that should not appear                                          |
| `forbidDisplacedShell`       | Fail when `run_shell` ran a command a first-class tool covers (#1845) |
| `maxInputTokens`             | Token budget guard                                                    |
| `forbidParallelExploreTurn1` | First assistant turn must not launch 2+ explores                      |
| `requireDoctrineCompliance`  | Fail when working-style doctrine heuristics violate (#744)            |
| `userIntent`                 | Optional `question` / `request` label for doctrine scoring            |
| `inScopePaths`               | Optional paths for doctrine `scopeDiscipline`                         |

## LLM judge (you)

After the analyzer JSON, write a short report:

1. **Issue fit** — Did the run address what the user cared about?
2. **Tool loop** — Sensible order? Duplicate explores? Missing git_diff on “review changes”?
3. **Steering vs behavior** — If `shouldSteerTodos` true but no `update_todos`, call that out.
4. **Answer quality** — Factual vs repo, actionable, hallucinations.
5. **Verdict** — Pass / fail / partial; one concrete next change (prompt, heuristic, or product).

Use the user’s exported JSONL from Downloads the same way: `pnpm run analyze:thread -- ~/Downloads/foo.jsonl` then judge in prose.

## Scenario authoring tips

- **Prompt catalog:** `tests/fixtures/todo-steering-prompts.json` lists prompts that must / must not match `shouldSteerTodos()` (enforced by `src/shared/todos/todo-steering-prompts.test.ts`). Reuse these for agent eval scenarios.
- **Strict todo evals:** `todo-steer-implement-test.json` and `todo-steer-refactor-several-files.json` set `requireUpdateTodos: true` for action prompts. Review/audit scenarios (`todo-steer-deep-dive`, `todo-steer-review-diff`) only assert steering + tool use — todos are optional there.
- One scenario per issue; keep `prompts` short and realistic (what a user would type).
- Multi-turn: add follow-up strings to `prompts` in order; the driver waits for idle between each.
- For “review my diff” issues, set `expect.requireTools: ["git_diff"]`.
- For todo steering issues, set `expect.shouldSteerTodos: true` and optionally `requireUpdateTodos: true` when you want strict compliance.
- **Tool preference over shell:** `forbidDisplacedShell` fails a run that drove `gh` or network `git` through `run_shell` when a dedicated tool (`gh_pr_view`, `gh_run_list`, `get_ci_status`, …) would have done the job — see `DISPLACED_SHELL_SHAPES` in `scripts/lib/eval-tool-expectations.mts` for the exact table. Local `git log` and `gh api` are deliberately NOT flagged, so this is not "forbid all `run_shell`". The analyzer reports a `displacedShellHistogram` whether or not the scenario fails on it, which is how you take a baseline before turning the gate on. The e2e-only `toolUse.maxShellEscalationPrompts` adds a looser ceiling read from the thread spine's decision causes.
- **CI diagnose / forensics steering:** `ci-diagnose-first-class-tools.json` also sets `forbidDestructiveGitShell` (no `reset --hard` / `clean -fd` for branch setup) and `forbidCopseWorkspaceShell` (no shell into `~/.copse/workspace`; use `read_archive` / file tools). Prompt classes with fixed intent but varied wording go in `promptVariants`; select one with `COPSE_EVAL_PROMPT_VARIANT=<index>`. `git-ci-first-class-tools.json` is the worked example for CI status; `ci-diagnose-first-class-tools.json` is the diagnose-main-CI companion. For an explicitly scoped Guarded YOLO evaluation, `toolUse.armGuardedYolo: true` (or `COPSE_EVAL_GUARDED_YOLO=1`) selects that behavior; record it in the report rather than silently changing autonomy to improve a score.

## Evidence and limits

A mock run validates the harness and UI integration, not model quality. A deterministic analyzer
pass does not establish correctness of the final answer; inspect the trace and verify its claims
against the scenario workspace. Report failed expectations, missing artifacts, and infrastructure
blockers separately. Compare changes using the same scenario, model, and configuration; disclose
run-to-run variance rather than treating a single success as a reliability measurement.

For a visible change, pair the run with focused DOM assertions and screenshots using
[screenshot-validate](../screenshot-validate/SKILL.md). Follow `AGENTS.md` for remaining validation
before committing. Keep raw traces as evidence and do not publish credentials or private content.

## When not to use this skill

- Pure UI layout → `screenshot-validate`
- Unit logic only → `pnpm test`
- Headless “does local model finish with text?” → `pnpm run validate:local-agent`
