# Long-horizon tasks (within a PR)

Tracking: [#558](https://github.com/copse-dev/agent-pane/issues/558)

Status: **experimental scaffold** — off by default behind the first-party pack
`copse.long-horizon-tasks` (Settings → Packs). Tracking PR:
[#1084](https://github.com/copse-dev/agent-pane/pull/1084).

## What this is

Some work within a single PR is a grind, not a one-shot: clearing a large lint/type-safety
backlog (cf. #508), or a deep research/investigation pass. This gives the agent a durable,
resumable checkpoint for such a task — a checklist of steps with done/remaining state and a
next-step cursor — so it can sustain progress across many turns and sessions, resume after
an interruption, and know when it is actually finished rather than stopping after one round.

This is the "within a PR" companion to the roadmap-plans feature (#556), which covers the
"across PRs" horizon.

## What landed in this scaffold

- **Pack** `copse.long-horizon-tasks` (`packages/agent/src/packs/long-horizon-tasks-pack.ts`)
  — first-party pack declaring the `track_long_task` native tool + namespaced storage. The
  Settings → Packs toggle is the atomic master switch (same pattern as P5's
  `copse.model-comparison`). A one-time `migrateLongHorizonTasksEnablement()` bridge in
  `pack-service.ts` preserves any prior `longHorizonTasksEnabled=true` opt-in and otherwise
  seeds the pack into the persisted disabled set (default OFF).
- **Store** `src/main/services/storage/long-task-tracker.ts` — per-project JSON persistence
  under `~/.copse/long-tasks/<workspace>/tasks.json`, zod-validated. A task has a `goal`
  (its terminal condition), an ordered `steps` checklist, and a `taskProgress()` helper that
  reports done/total, completeness, and the next step.
- **Tool** `track_long_task` (`src/main/tools/long-task-tool.ts`) — `create` / `check` /
  `status` / `list` plus an explicit one-shot `continue`, registered via
  `syncLongHorizonTasksTools` in `registry-bootstrap.ts` (boot + live
  `packs:setEnabled`). `continue` schedules a durable supervisor wake bound to the
  current project, thread, turn-tree epoch, and permission snapshot. The wake dispatches
  one bounded machine turn and asks that turn to schedule another only if checklist work
  remains.
- **Tests** `long-task-tracker.test.ts`, `long-horizon-tasks-pack.test.ts` (registration +
  atomic disable), `pack-service.test.ts` (default-OFF migration),
  `settings-packs.e2e.ts` (pack row defaults off), and `settings-experimental.e2e.ts`
  (retired `longHorizonTasksEnabled` fieldset gone). Pack toggles emit `settings_changed`.

While the pack is disabled the tool is not registered. Any already-persisted wake
completes without dispatching an agent turn.

## Relationship to existing state

- **`Thread.todos` (#530)** is scoped to a single thread; a long task here is durable and
  outlives the thread/session. A follow-up could let a thread's todos seed or sync with a
  long task.

## Not yet built (follow-ups on the issue)

- **Chunked commit cadence** — batch the grind (per-file / per-rule) with commits as it
  goes, so a long run stays resumable and reviewable.
- **Status surfacing** — show progress in the UI without spamming the user.
- **CI integration** — let this drive the babysit-PR / CI-investigator loop so
  "grind until green" is first-class.
