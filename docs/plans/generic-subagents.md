# Generic native subagents

## Task brief

A native parent thread needs to delegate a bounded task without creating an agent
definition file. The parent chooses the task, supplied context, exact tools, task
role and required intelligence. Model IDs remain a Settings concern.

Scope: native synchronous workers in the owning checkout. Existing named agents,
external ACP agents and isolated-worktree workers retain their contracts. This
change affects agent control flow and tool authority; full check and focused
runtime/visual evidence are required.

## Reviewed contract

- `run_agent({ task, context, tools, task_type, intelligence })` uses the existing
  role registry. Both routing fields default to `match`; intelligence otherwise
  accepts `low`, `mid`, or `top`.
- Match classifies the child task, with supplied context size included in the
  intelligence estimate. This is the existing heuristic, not a quality guarantee.
- Configured role assignments (including existing legacy role settings) win.
  Reviewer and safety retain their protected settings. Dynamic selections resolve
  through the existing resolver. An unknown or lower measured intelligence is
  reported, without silently replacing the assigned model.
- Unassigned roles select the cheapest available callable model meeting the
  requested band. The existing candidate pool applies provider, maker, data-policy
  and plan-coverage filters. No matching route fails before inference; there is no
  silent downgrade or external-agent fallback.
- Only task/context and workspace identity are forwarded. Parent history, working
  brief and skill activation are not copied. This limits automatic context
  forwarding, not access to workspace files through tools explicitly supplied.
- Tool names must match exactly. Empty means no tools. Unknown, forbidden,
  project-unavailable or read-only-incompatible tools reject the whole request.
  Every execution rechecks membership and uses the ordinary registry gate.
- No recursive delegation, commits, parent-plan updates, user questions, thread
  prompt sending or detached background tool. Ordinary selected tools retain the
  parent thread's permissions and sandbox. File edits use the owning checkout;
  the parent must avoid overlapping writes.
- Shares the two-worker per-parent-turn allowance and supervisor with named
  workers. Twelve loop steps, two-minute deadline, one attempt, no restart.
  Stop cancels owned work; late chunks are discarded. Reports identify routing,
  selected model, measured band and any mismatch.
- Existing subagent cards show the task, child activity, model and report. This is
  native-only; the external tool bridge does not expose it.

## Observable acceptance

1. A native parent can invoke an ad hoc worker without an agent definition.
2. The child provider receives only supplied context and selected tool schemas;
   invoking an unselected tool cannot reach its handler.
3. Read-only scope survives delegation, and recursive/detached tools are rejected.
4. Explicit roles use Settings; match infers the child role; unavailable routes
   fail and capability mismatches are reported.
5. Generic and named workers share admission limits and cancellation ownership.
6. A focused Electron scenario invokes the real native tool with scripted
   providers, asserts the child model/report and captures the subagent card.
   This demonstrates wiring, not real-model routing quality.

## Validation status

- Focused routing, runner, worker admission, registry and read-only tests: 70 passed.
- Full static gate (`check:local`) and production build passed.
- The full `check` attempt reached its 30-minute deadline during the unit suite.
  Its log includes sandbox denials for sockets, temporary directories and `ps`,
  plus other failures not yet compared against the base. It is not a full pass.
- Added a documented provisional E2E shard weight; the duration coverage invariant
  passes with the updated weights.
- Screenshot baseline access is resolved: the sandbox initially reported
  `ENOTFOUND`, while normal host access reached R2 and hydrated all 1,406 objects
  (`.tmp/generic-subagents-hydration.log`). No host allowlist/proxy change was needed.
- The host-terminal Electron run reached native delegation but failed the child
  mock completion assertion. Its failure artifact showed the child provider had
  no bound conversation scenario. Each prepared child now receives an independent
  provider scope; the runner's five tests, including a regression using two real
  provider builds and separate mock scenarios, pass.
- After that fix, typecheck (node, renderer, E2E and demo), targeted runner ESLint
  and the production build passed (background task
  `ef6e5b34-bb74-4e15-94a2-0149d4d7a387`, exit 0).
- The rebuilt focused Electron spec passed from the host terminal on 2026-10-31
  at 20:15 UTC: one passing test, exit 0, WebDriver session
  `bb82ca8b7bb732e3b87c59b316062948`. It verifies native delegation, the configured
  role/model, both mock scenarios completing and the displayed child report.
  Inspected `tests/e2e/screenshots/run-agent-configured-role.png`: the completed
  Run agent card shows Claude Sonnet 4.6 and the expected planning report, with
  readable routing output and the configured-model capability warning.
- The initial screenshot exposed duplicate raw JSON beneath the report; it was
  functional evidence, not acceptable visual completion. The renderer now unwraps
  the report for deduplication, shows the task and routing warning, and puts the
  raw result in a collapsed Technical details disclosure. All 13 subagent display
  component tests and all six adjacent card-reconciliation tests pass. Repository
  formatting check passes on all 4,919 files after formatting the new assertion.
  Typecheck, targeted ESLint and rebuild passed in task
  `dc1c81e5-1eeb-43f6-a254-d12e0969cd9c` (exit 0). The strengthened Electron spec
  checks that the duplicate result is absent and technical output is hidden until
  expanded. Inspected the newer screenshot saved at 20:29:26 on 2026-10-31:
  task and report appear once, the warning is separate, and Technical details is
  collapsed. The host-terminal run at 20:29 UTC passed the complete spec,
  including the final disclosure-expansion assertions (one passing test, exit 0,
  session `a69181da6ea358556d31659d5071266c`). The corrected card now has both
  passing runtime assertions and inspected visual evidence.
- Full-suite validation remains
  incomplete: beyond explicit sandbox denials, the existing log contains failures
  in protocol workflow checks (Bash unbound arrays), screenshot review (`/tmp`
  safety), shadow coverage selection, container runtime, Apple enrollment and
  search indexing. Those require baseline comparison before calling the full
  check noise-only; the worktree-manager timeout also prevented a clean completion.
- Focused triage (`pnpm test -- ci-workflow-invariants screenshot-review small-gate`)
  completed in task `95bd5798-0e22-430d-9d1c-903e45e81677`, exit 1: 166 passed,
  nine failed. Evidence: `.tmp/generic-subagents-triage-current.log`. The shard
  duration invariant now passes. Remaining failures are one Bash unbound-array
  error, six `Unsafe review directory: /tmp` errors, and two shadow-plan tests
  expecting an empty diff despite this checkout's uncommitted changes. These are
  not yet classified as baseline failures.
- Clean-baseline comparison is blocked: `git worktree add --detach
  .tmp/generic-subagents-validation-base HEAD` (base `7cd7f24ab`) cannot create
  the main repository's `.git/worktrees/generic-subagents-validation-base`
  directory (`Operation not permitted`). The normal `expects_sandbox_block`
  host-access retry returned the same error, with no deferred approval ID.
  Comparable clean-baseline test evidence is needed to complete the comparison;
  an existing prepared checkout/result at that revision can satisfy this without
  creating another checkout. No product changes were discarded or committed to
  manufacture a clean state.
- Reinspection found the full-check summary: 16,146 passed, 79 failed, 11 cancelled,
  31 skipped (`.tmp/generic-subagents-check-3.log:27953`). Saved baseline evidence
  covers screenshot hydration and accessibility-baseline growth, not clean-source
  unit comparison. Several Apple/container failures explicitly cite denied
  storage-maintenance lock writes; several SSH/index failures cite denied
  `/tmp/copse-ssh-501` creation. Other assertions/timeouts remain unclassified.
  A local, unpublished PR description with exact evidence and remaining gates is
  preserved in `.tmp/generic-subagents-pr-draft.md`.
- Isolated search triage (`pnpm test -- semantic-index-quit workspace-indexing`)
  completed in task `145b5547-8225-4ce3-bf38-8f577a0046dc`, exit 1: 14 passed,
  three failed, no cancellations. Log: `.tmp/generic-subagents-search-triage.log`.
  Both restart timeouts follow `spawn EPERM` in `pidRssAndCommand`, whose macOS
  implementation invokes `ps`. The registration test fails `isRootWatched` after
  an `EMFILE` watcher error. These reproduce in isolation, so full-suite load
  alone does not explain them. This establishes concrete environment failures,
  not a clean-base comparison or a full-check pass. No repeat run is needed
  without a changed environment or baseline evidence.
