# Project automations

**Status: Experimental local workflow shipped.** The default-off `copse.automations` pack,
schedule editor, local ticker, **Run now**, fresh grouped tasks, bounded worktree use,
and renderer submission are implemented. The durable/headless behavior below remains planned.

This plan defines the first local prototype of Copse automations. It is a thin,
explicitly limited slice of the durable background supervisor proposed in
GitHub issue #1081 and the local/cloud split proposed in #875.

## Prototype: local cron → agent task

An enabled, project-scoped schedule contains a name, five-field cron expression,
prompt, and selected model. While the desktop app is running, a matching minute
starts a fresh task and root turn for that schedule. The thread is model-pinned
for the turn and the renderer submits its prompt through the normal checkout and
agent-run paths.

## Bounded local lifecycle

The local workflow has three invariants aimed at unattended reliability:

1. **A fresh thread per run, grouped by schedule.** Every successful trigger gets
   empty conversation context and its own task identity. Automation tasks render
   under one collapsed **Automations** disclosure per project, then coalesce under
   their schedule name. Expanding a schedule reveals timestamped historical runs;
   selecting one reveals both disclosures.
2. **A small live-worktree budget per schedule.** Every run explicitly requests
   an isolated worktree even when ordinary project threads default to the shared
   checkout. Before creating the next task, Copse retires clean, fully merged
   checkouts and accepts already parked PR checkouts. The safe default allows one
   live worktree; a schedule author may explicitly raise the cap to two or three
   when independent runs should continue while older changes await review. Once
   that cap is reached, the new trigger is skipped rather than producing an
   unbounded trail of worktrees.
3. **No overlapping turns.** A trigger that finds the schedule's latest task running
   or holding an unsubmitted scheduled draft is coalesced. It neither creates a
   thread/worktree nor queues another turn. The next matching cron occurrence may
   try again after the thread returns idle.

Attention pierces the quiet grouping without opening the entire history. If a
background automation task pauses for approval or a question, the sidebar reveals
**Automations**, its schedule, and only the affected run row. The bell stays on
that actionable row; the schedule keeps a right-facing chevron until the user
explicitly expands the older runs.

Legacy automation threads that resolved onto a shared checkout remain historical;
the next successful trigger creates a fresh isolated task. Archived automation
threads are likewise never resurrected.

The schedule authorizes submission of the configured prompt, not broader tool
access. Normal permission policy remains in force: sandbox-contained commands
follow the user's current auto-run setting, and commands that require approval
still pause the scheduled thread and prompt. A checkout failure keeps the prompt
as an unsent draft; provider failures surface on the started thread, matching an
interactive submission.

The renderer currently owns interactive agent streams and transcript persistence.
Consequently, a task for the active project starts immediately; a task created for
an inactive project starts when that project is next opened. True headless execution
while no renderer owns the project belongs to #1081's durable supervisor and #1079's
shared turn contract rather than a second automation-specific runtime.

Prototype boundaries:

- local machine and local wall-clock time only;
- Copse must be running;
- standard five-field cron, evaluated once per minute;
- no missed-run catch-up, retry/backoff, cross-schedule concurrency cap, or process recovery;
- no webhook/event triggers;
- no headless execution for an inactive project or closed renderer.

The minute clock is now a durable recurring task owned by #1081's shared supervisor;
the schedule/IPC shape remains an Automations consumer. Pack disablement cancels the
operational scheduler task while preserving schedule configuration; re-enabling creates
one replacement owned by an enabled schedule's project.

This is deliberately an **app-open automation**, not yet a background agent under the
definitions in [`background-agents-capability-map.md`](background-agents-capability-map.md):
the desktop and relevant renderer still own execution. Device-independent scheduled
work requires the shared headless-turn contract, supervisor lease, and detached runtime.

## Beyond cron: trigger adapters

PR/ticket events, CVE advisories, alerts, webhooks, and chat/mobile requests are not extra
fields on `AutomationSchedule`. They normalize to the supervisor's authenticated,
immutable trigger envelope and select a registered workflow/profile. Delivery is
deduplicated and auditable; the trigger authorizes enqueueing that workflow, never
arbitrary tool access. App-open polling can be an early adapter, while always-available
ingress waits for the detached worker/control-plane phase.

## Pack boundary

`copse.automations` is a default-off first-party pack. The pack owns atomic
enablement, a level-3 `settings-pack-detail` UI declaration, and its namespaced
storage declaration. Host code owns the clock and thread-store write; renderer
code owns the project/model-aware editor and dispatches due prompts through the
existing interactive agent controller. This follows the two-capability-tier
decision in `hooks-and-feature-packs.md`: a user pack cannot ship an in-process
scheduler or arbitrary renderer code.

Disabling the pack stops new triggers but preserves schedules and already-created
threads. History never consults live pack registration (decision 17).

## Verification and model comparison

The current model-comparison harness compares two reviews of a working Git diff.
That is useful after an editing automation, and the existing global
`modelComparisonAutoOnReview` path still applies when the automation changes
files. It is not yet a general verifier for issue triage, documentation freshness,
or roadmap classification: those tasks need two independent task results plus a
judge over structured evidence, not two diff reviews.

Do not silently turn on billable comparison for schedules. The existing comparison
approval is interactive and remembered per thread; an unattended trigger cannot
answer it. A future per-schedule verification policy must therefore capture an
explicit model/cost budget when the schedule is saved, run the two workers with
separate read contexts, judge a schema-validated result, and record agreement,
disagreement, evidence, and spend in the schedule thread. Until that contract
exists, prompts may request the existing comparison tool, but the normal approval
boundary remains in force.
