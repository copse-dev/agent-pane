# Long-horizon tasks (within a PR)

Tracking: [#558](https://github.com/jonathanKingston/agent-pane/issues/558)

Status: **experimental scaffold** — off by default behind the `longHorizonTasksEnabled`
setting (Settings → Experimental).

## What this is

Some work within a single PR is a grind, not a one-shot: clearing a large lint/type-safety
backlog (cf. #508), or a deep research/investigation pass. This gives the agent a durable,
resumable checkpoint for such a task — a checklist of steps with done/remaining state and a
next-step cursor — so it can sustain progress across many turns and sessions, resume after
an interruption, and know when it is actually finished rather than stopping after one round.

This is the "within a PR" companion to the roadmap-plans feature (#556), which covers the
"across PRs" horizon.

## What landed in this scaffold

- **Setting** `longHorizonTasksEnabled` (experimental, default off) — schema in
  `settings-writable.ts`, UI in the Experimental section of `settings-dialog.ts`.
- **Store** `src/main/services/long-task-tracker.ts` — per-project JSON persistence under
  `~/.copse/long-tasks/<workspace>/tasks.json`, zod-validated. A task has a `goal` (its
  terminal condition), an ordered `steps` checklist, and a `taskProgress()` helper that
  reports done/total, completeness, and the next step.
- **Tool** `track_long_task` (`src/main/tools/long-task-tool.ts`) — `create` / `check` /
  `status` / `list`, registered only when the flag is on (`registry-bootstrap.ts`).
- **Tests** `long-task-tracker.test.ts`.

While the flag is off the tool is not registered and nothing reads or writes the store.

## Relationship to existing state

- **`Thread.todos` (#530)** is scoped to a single thread; a long task here is durable and
  outlives the thread/session. A follow-up could let a thread's todos seed or sync with a
  long task.

## Not yet built (follow-ups on the issue)

- **Self-paced loop** — drive the agent to keep going until the task's terminal condition
  (lint count zero / `npm run check` green / research answered) instead of stopping early.
- **Chunked commit cadence** — batch the grind (per-file / per-rule) with commits as it
  goes, so a long run stays resumable and reviewable.
- **Status surfacing** — show progress in the UI without spamming the user.
- **CI integration** — let this drive the babysit-PR / CI-investigator loop so
  "grind until green" is first-class.
