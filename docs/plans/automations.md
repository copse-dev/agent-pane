# Project automations

**Status: Experimental local workflow shipped.** The default-off `copse.automations` pack,
schedule editor, local ticker, **Run now**, fresh grouped tasks, bounded worktree use,
and renderer submission are implemented. The durable/headless behavior below remains planned.

> **Status update (2026-10-07).** Event triggers, delivery history, worktree hand-over between
> runs, and named failure states are now implemented on top of this prototype; see
> [Event-driven automations](event-driven-automations.md#status-update-2026-10-07) for what
> shipped and what is still open. The cron lifecycle below is unchanged except where noted inline.

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
   checkout. **Hand-over:** a finished run's checkout is _taken over_ by the next run of the
   same automation instead of being retained or recreated, when that is provably safe (see
   [Worktree hand-over](#worktree-hand-over)). Before creating the next task, Copse retires clean, fully merged
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

The schedule authorizes submission of the configured prompt and starts with no
extra tool grants. Its editor offers an explicit, schedule-scoped allow-list for
exact MCP tools and the supported mutating Copse GitHub actions. The editor presents
the complete eligible catalogue in one filterable list, including saved tools
that are temporarily offline. Copse actions apply only to the current project
repository; an explicit `owner` / `repo` target still prompts. If an unselected
eligible tool interrupts an automation thread, the approval dialog can add that
exact tool to the owning schedule instead of making a global grant. Disconnected
MCP selections stay visible and inert until the same exact tool returns.

Everything else keeps the normal permission boundary: shell commands, file
approvals, websites, sensitive-data reveals, ACP permission kinds, and model
spend cannot be represented by an automation grant. Read-only mode and blocking
hooks run before this allow-list. A checkout failure keeps the prompt as an unsent
draft; provider failures surface on the started thread, matching an interactive
submission.

Thread metadata is renderer-visible and therefore does not prove automation
ownership. Before applying a grant, main matches the claimed schedule, thread id,
and trigger time to that schedule's main-owned latest-run record. A copied or
edited metadata claim fails closed and follows the ordinary approval path.

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
- no webhook ingress; an app-open GitHub Actions branch-failure poller is the first event adapter;
- no headless execution for an inactive project or closed renderer.

The minute clock is now a durable recurring task owned by #1081's shared supervisor;
the schedule/IPC shape remains an Automations consumer. Pack disablement cancels the
operational scheduler task while preserving schedule configuration; re-enabling creates
one replacement owned by an enabled schedule's project.

This is deliberately an **app-open automation**, not yet a background agent under the
definitions in [`background-agents-capability-map.md`](background-agents-capability-map.md):
the desktop and relevant renderer still own execution. Device-independent scheduled
work requires the shared headless-turn contract, supervisor lease, and detached runtime.

## Worktree hand-over

Before this change a finished run's checkout was removed only when it was entirely clean —
_including ignored files_. A checkout holding only `node_modules` or build output therefore
counted as retained forever, and at the default cap of one the schedule skipped every later
run behind it ("live worktree limit"). The next run now takes over that checkout when **all**
of these hold (`adoptThreadWorktree`, re-proved under the repository lock):

- it is the schedule's most recent run that still holds a checkout, that run is settled (not
  running, no unsent draft), and no terminal, background process or ACP session is live in it;
- the checkout is registered, on its branch, with no merge/rebase in flight, and has no modified,
  staged or untracked (non-ignored) file;
- its branch holds no commit beyond the base it was cut from, so nothing can be lost;
- it has no PR (those follow the parking lifecycle) and the requested base branch is unchanged;
- the project checkout is clean, so a fresh allocation would not have seeded anything this one
  lacks.

The result is meant to be indistinguishable from a fresh allocation: every ignored file is
deleted (confined to the checkout's real path), the branch and tree move to the current base
tip with `git switch -C`, the checkout is `git worktree move`d to the new thread's path (paths
are derived from the thread id), and ignored project files are re-cloned exactly as for a new
checkout. Nothing a previous run wrote — including a `.env` it created — survives. The branch keeps
its name; the old thread's checkout is recorded as retired. Hand-over never relaxes the cap: at
most one checkout is handed over per run, and one that cannot be inspected counts as retained.

Failure behaviour: an ineligible checkout is left untouched and the run allocates a fresh one.
After the move, errors are surfaced rather than masked; the checkout then sits at the new
thread's path, where `recoverUnpersistedWorktree` reclaims it on retry, so it is never an orphan.
Known limit: if the hand-over is refused _after_ the cap check admitted the run (the checkout
changed in between), the run allocates a fresh checkout and the schedule briefly holds one more
than its cap; the next trigger then sees both and skips until one is resolved.

## Failure states

Each way an unattended run can stop is a named code (`AutomationFailureCode`) with a plain
message and one remedy, shown in the Automations manager and in Activity:

| Code                | When it is recorded                                                           | Shown                                               |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `approval-stalled`  | An approval/question of an automation run unanswered for 15 minutes (derived) | Activity row + detail                               |
| `worktree-failed`   | Checkout preparation threw before the run started; the prompt stays a draft   | Run thread, Activity, manager row (via main)        |
| `no-model`          | Start/turn error naming a missing or unavailable model                        | Run thread, Activity, manager row                   |
| `auth-expired`      | Turn failed with a 401/credential error                                       | Run thread, Activity, manager row                   |
| `container-missing` | Error text names an unavailable container engine (see below)                  | Same as above                                       |
| `scheduler-stopped` | The supervisor task that fires schedules and polls events failed or blocked   | Manager banner and an Activity notice, all projects |
| `unknown`           | Anything else that ends a run in error                                        | Activity ("Run failed — open the run")              |

Honest limits: runtime failures (`no-model`, `auth-expired`, `unknown`) are classified from the
error text and recorded on the thread, so the manager sees them only while that project's threads
are loaded; start failures are also reported to main and survive with the project closed. A cron or
event _trigger_ cannot dispatch into a container today, so `container-missing` can only appear if
an error message names the engine; container runs have their own error surface.

## Beyond cron: trigger adapters

PR/ticket events, CVE advisories, alerts, webhooks, and chat/mobile requests are not extra
fields on `AutomationSchedule`. They normalize to the supervisor's authenticated,
immutable trigger envelope and select a registered workflow/profile. Delivery is
deduplicated and auditable; the trigger authorizes enqueueing that workflow, never
arbitrary tool access. App-open polling can be an early adapter, while always-available
ingress waits for the detached worker/control-plane phase.

## Pack boundary

### Integrated editor

The side cog opens a menu with **Automations** and **New automation…**. The
adjacent Settings label remains a direct shortcut. Both menu actions mount the
same project-scoped editor used in Settings in a native modal, with an explicit
plugin enable/disable action. Changing enablement preserves an unsaved draft.
Sidebar automation setup links use this modal too; the modal closes if the active
project changes. No second store, scheduler, or form is introduced.

The first-party plugin declares `automation-manager` in the level-3 `app-dialog`
slot. The host only exposes this shipped view when the matching first-party
declaration is present. Like Settings, configuration is reachable while disabled;
the plugin flag continues to gate scheduled execution and Run now.

Acceptance criteria:

- The side cog opens the automation list or a new automation form without opening Settings.
- Settings and the modal edit the same project-owned schedules using the same editor.
- Plugin enablement preserves an unsaved draft; disabled plugins cannot run automations.
- Sidebar setup links open the named schedule in the modal, and project changes close it.
- Focused Electron coverage saves cog-menu, creation, and management screenshots.

### Ownership

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
