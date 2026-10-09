---
name: on-machine-eval
description: Validate a specified Copse PR in a suitable browser, Electron, or real-agent environment with focused tests and visual evidence. Use for on-machine PR validation, platform-specific reproduction, or proving a UI fix before merge.
---

# On-machine PR eval

Coordinate evidence for the requested PR. Read `AGENTS.md` and the current
`docs/agent-development.md` and `docs/testing-strategy.md` from the repository root.
Use [pr-screenshot-review](../pr-screenshot-review/SKILL.md) when only existing screenshot
candidates need assessment; this skill is for executing the product and its tests.

## Establish the target and scope

1. Resolve the supplied PR, record its URL, head/base SHAs, and inspect its diff and test plan.
   If no target can be inferred, ask for it rather than selecting an unrelated open PR.
2. Record observable acceptance criteria and choose the machine/tier that can prove them.
3. Use an isolated checkout/worktree of the exact head. Preserve unrelated user changes and running
   app sessions. Record whether evidence is from the head itself or a merge/rebase with the base.
4. For an assessment request, report results. When fixes are requested, keep them on the feature
   branch rather than opening a stacked validation PR. Commit/push and update PR descriptions only
   within the user's authorized scope; do not automatically close other PRs or merge branches.

## Select the evidence path

| Behavior                                                 | Workflow                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pure logic, DOM structure, events                        | Focused unit/component tests and the oracle-selected gates               |
| Deterministic renderer geometry                          | Browser tier via [screenshot-validate](../screenshot-validate/SKILL.md)  |
| Native sizing, Monaco, terminal, webview, real IPC       | Electron tier via [screenshot-validate](../screenshot-validate/SKILL.md) |
| Model/tool-loop quality, steering, final answers         | [agent-run-eval](../agent-run-eval/SKILL.md)                             |
| Authenticated ACP, native macOS UI, real-model recording | `docs/remote-agent-demo-debugging.md`, plus focused automated evidence   |

Prefer an available remote-e2e host for Electron iteration; use local runs for platform-specific
behavior or when remote is unavailable. A Linux render does not prove a macOS-only behavior, and a
macOS pass does not resolve a Linux failure. For native/real-model GUI debugging, isolate both the
app profile and project and keep at least one run visible as required by `AGENTS.md`.

## Execute and evaluate

1. Follow the selected skill for seeding, focused assertions, captures, and exact commands.
   Reuse existing specs where possible. A build or manual desktop inspection alone cannot prove a
   visible change. Mock scenarios prove UI/tool plumbing, not real-model behavior.
2. Inspect screenshots and runtime artifacts. Explain discrepancies rather than replacing the
   baseline to make the comparison pass. Preserve CI Linux reference ownership.
3. If fixes are in scope, make the smallest correction and rerun the affected checks. Otherwise
   report the reproducer and finding. Distinguish product failures from environment blockers.
4. Run the oracle and follow `AGENTS.md` for focused tests and the required full or eligible local
   gate before committing. Read `wdio.ci.conf.ts` and current CI workflows for actual coverage and
   exclusions; `test:e2e:ci` is not a single-spec smoke test.
5. Recheck the PR head before publishing results or pushing authorized fixes. If it moved, identify
   which evidence is stale and rerun as needed. Do not claim evidence for a different commit.

## Report

Include the PR URL and tested SHA, acceptance criteria, machine/OS and harness, exact commands and
outcomes, screenshots/trace paths, and a pass/fail/partial verdict. Name untested behavior and
infrastructure blockers. Link fixes actually pushed and distinguish them from recommendations.
For screenshot acceptance, hand off the candidate decision to `pr-screenshot-review`; passing this
workflow alone does not accept baselines or establish that the whole PR is ready to merge.
