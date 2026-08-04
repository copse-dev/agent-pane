# Background task supervisor

Tracking: [#1081](https://github.com/copse-dev/agent-pane/issues/1081)

**Status: Active (P4 complete).** Design contract is on `develop` via [#1170](https://github.com/copse-dev/agent-pane/pull/1170).
P1 landed the Zod/JSON schema + pure load/reconcile helpers. P2 adds the durable
main-process store, lifecycle APIs, restart reconciliation, and one-shot scheduling
without registering a production consumer yet. Implementation PRs should link here
and keep long-horizon checklists (#558), dark-factory orchestration, A2A/remote
delegation (#1015), and `run_background` shell tasks as **consumers**, not alternate
supervisors.

Parent investigation: [`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md).
Related foundations: [`long-horizon-tasks.md`](long-horizon-tasks.md),
[`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md),
[`execution-runtime-security.md`](execution-runtime-security.md),
[`../thread-store-format.md`](../thread-store-format.md). Headless adapters that later
wake or resume supervised work must share [#1079](https://github.com/copse-dev/agent-pane/issues/1079)'s
turn contract rather than inventing a second runtime.

## Why this plan exists

Copse already has several "keep working after the turn" surfaces, but none owns the
shared lifecycle Grok Build's background-tasks model implies: durable identity, wake
triggers, cancellation, permission snapshots for delayed execution, and a single place
to ask "what is still running / waiting / blocked?"

| Surface                              | Role today                                   | Gap versus a general supervisor                                      |
| ------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| `run_background` (#691)              | In-memory child processes for a live session | Dies with the process; no queue, schedule, or cross-restart recovery |
| Long-horizon checklists (#558)       | Goal/step state machine for grind-until-done | Tracks progress; does not schedule wakes or own concurrency policy   |
| CI investigator / PR pane            | On-demand or event-driven CI reads           | No durable poller; each feature would otherwise grow its own timer   |
| Dark-factory orchestrator (proposed) | Fleet nurse + triage for Copse/user PRs      | Explicitly needs a shared scheduler (audit: none in `src/main`)      |
| A2A / remote delegation (#1015)      | Durable remote tasks and handoff             | Needs ownership, cancel, and resume semantics — not a second queue   |
| Hooks `asyncRewake`                  | Unsupported in v1 (hooks plan decision 11)   | Must not become a side-channel wake path around the supervisor       |

#1078's ownership map assigns this shared infrastructure to #1081. This plan defines
the binding decisions, minimum contract, and the smallest design→implementation
sequence. Recurring schedules land **after** one-shot and event-driven wakes work.

## Binding decisions (do not reopen lightly)

1. **One supervisor owns delayed and long-lived work.** Features may define _what_ to
   run (handlers, policies, UI), but must not each own timers, persistence, cancel
   trees, or retry loops. Dark-factory, long-horizon self-pace, A2A follow-ups, and
   monitors are consumers.
2. **Supervisor ≠ checklist ≠ Plan Mode.** Long-horizon (#558) remains the goal/step
   state machine. Plan Mode (#1080) remains the explore→approve→implement transaction.
   The supervisor owns queued/running/waiting lifecycle and wake triggers only.
3. **`run_background` is a process handle, not the product.** Keep the experimental
   shell tool for in-session processes; supervised tasks may _attach_ or _spawn_
   process handles, but durable task identity and recovery live in the supervisor
   store, not the in-memory `Map` in `background-process.ts`.
4. **Durable task identity with explicit ownership.** Every task records
   `taskId`, owning `projectId` / `threadId` (and turn/agent when applicable),
   provenance (`user` \| `agent` \| `system` \| `schedule`), and a handler kind.
   Orphaned tasks are visible and cancellable; they are never silently adopted by a
   different thread without an explicit reassignment record.
5. **Permission snapshots for delayed execution.** A wake that would run tools or
   shell must carry the approval context captured at schedule/enqueue time (or an
   explicit "re-prompt on wake" policy). Delayed work must not inherit ambient UI
   trust or broaden defaults because no window is focused. Fail closed when the
   snapshot is missing or the policy cannot be satisfied (#1079 / execution-runtime
   security honesty).
6. **No second authorization engine.** Reuse `decideShellPermission` /
   permission-gate and existing capability profiles. The supervisor stores _when_ and
   _whether_ to re-ask; it does not invent prefix-allow shortcuts.
7. **App restart and renderer closure are first-class.** On main-process start, the
   supervisor reconciles persisted tasks: mark dead process handles, re-arm eligible
   wakes, and surface blocked/failed tasks. Closing the renderer must not cancel
   supervised work unless the task explicitly requires an interactive session.
8. **Inert when unused.** If no supervised tasks exist and no consumer is enabled, the
   supervisor starts no timers and opens no stores beyond a cheap existence check
   (same "fully inert while off" bar as dark-factory decision 11).
9. **#1068 stays binding.** Active-task narrative stays in the thread; supervisor
   records are operational telemetry (queue/state/handles). Do not promote wake logs
   into durable project knowledge unless the user explicitly does.

## Minimum contract

### Task lifecycle

| State       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `queued`    | Accepted; waiting for a concurrency slot or start gate                 |
| `running`   | Handler actively executing (agent turn, process, or deterministic job) |
| `waiting`   | Suspended until a wake trigger (time, event, dependency, human)        |
| `blocked`   | Needs human/input/permission before it can continue                    |
| `cancelled` | Terminal; cooperative cancel requested and acknowledged                |
| `failed`    | Terminal; handler error or policy denial after retries exhausted       |
| `completed` | Terminal; success payload available to the owning thread/UI            |

Transitions are append-only in an audit log. Consumers observe state; they do not
mutate foreign tasks except via supervisor APIs (`cancel`, `retry`, `reassign` with
policy checks).

### Task record (minimum fields)

Names illustrative; schema lands in P1:

- `taskId`, `projectId`, `threadId`, optional `parentTaskId`
- `handler`: stable kind string (e.g. `long_horizon_continue`, `pr_fleet_poll`,
  `a2a_followup`, `shell_process`)
- `state`, `createdAt`, `updatedAt`, `startedAt`, `finishedAt`
- `trigger`: `immediate` \| `wake_at` \| `event` \| `cron` (cron deferred to P4+)
- `permissionSnapshot` / `reapproveOnWake` policy
- `concurrencyClass` + optional `resourceBudget` hints
- `lastError`, `attempt`, `maxAttempts`
- `resultRef`: pointer into thread spine, blob, or handler-specific artifact
- content/integrity hash when the payload will authorize later tool use

Storage: project-scoped under the Copse workspace root (beside threads), human-readable
JSON/JSONL preferred so `@`-tools and support dumps can inspect it. Not electron-store.

### Wake triggers (ordered delivery)

| Trigger        | v1 expectation                                            |
| -------------- | --------------------------------------------------------- |
| Immediate      | Start when concurrency allows                             |
| `wake_at`      | One-shot timestamp; survives restart                      |
| Event-driven   | Named internal events (CI status change, process exit, …) |
| Recurring cron | **Out of scope for first implementation phases**          |

Event subscriptions are registered through the supervisor so dark-factory and similar
features do not each open GitHub pollers.

### Cancellation, concurrency, retention

- Cancel is cooperative with a bounded force deadline (mirror subprocess kill grace).
- Global and per-`concurrencyClass` caps prevent fleet pollers from starving interactive
  agent turns.
- Retention: terminal tasks compact after a configurable window; audit summaries remain
  queryable for support. High-volume sensor observations (e.g. CI check-run history)
  may live in handler-specific stores but must still _register_ their parent supervised
  task when they imply ongoing work.

### Notification and resume

- Completions/blocks can notify the desktop (toast / attention) and/or append a thread
  event so the next turn sees the result.
- Headless/ACP resume uses #1079's contract; the supervisor does not invent a parallel
  "background chat" protocol.

## First delivery slice (this PR's scope)

Ship **design-only** artifacts that unblock implementation without choosing UI chrome:

1. This plan (contract + phases + exit gates).
2. Index entry in [`README.md`](README.md).
3. Explicit ownership link from the Grok Build comparison map to this doc.

Out of scope for the first slice: timer loops, JSON schema modules, Settings toggles,
dark-factory poller implementation, and changes to `run_background`.

## Later phases

### P1 — Schema + persistence sketch

- [x] Zod source of truth in `src/shared/supervisor/task-schema.ts` + published
      `schemas/copse-supervisor-task.schema.json`.
- [x] On-disk layout under `~/.copse/workspace/<projectId>/tasks/<taskId>/`
      (`meta.json` + append-only `audit.jsonl`) — Open Q1 resolved: beside threads under
      the project dir; reuses `COPSE_WORKSPACE_DIR` (no sibling tree / new override).
- [x] Pure `reconcileSupervisedTasks` helper (fake-clock / restart-shaped; no fs).
- [x] Exit gate: fixtures under `tests/fixtures/background-supervisor/` validate;
      unit tests cover schema + reconcile without Electron.

### P2 — Main-process supervisor service (no consumers)

- [x] Singleton lifecycle: reconcile on startup, inert when empty.
- [x] APIs: `enqueue`, `cancel`, `list`, `get`, `acknowledgeBlock`.
- [x] In-process immediate + `wake_at` only; no GitHub/network sensors yet.
- [x] Exit gate: unit tests advance fake clocks across restart-shaped reload.

### P3 — First consumer: long-horizon continue (#558)

- [x] Optional self-paced wake that asks the agent to continue a checklist without each
      feature owning `setInterval`.
- [x] Permission snapshot + re-approve rules pinned with tests.
- [x] Exit gate: pack-disabled ⇒ no wakes; pack-enabled ⇒ one supervised task drives a mock
      continue turn.

### P4 — Event wakes + dark-factory sensor registration

- [x] Durable one-shot event waiters and reference-counted event-source registration for
      CI/process events.
- [x] Dark-factory adaptive poller becomes a supervisor-backed job (still
      feature-flagged inert when off).
- [x] Exit gate: two consumers cannot register duplicate pollers for the same fleet key.

### P5 — UI surfacing + recurring schedules

- Desktop list of supervised tasks (running/waiting/blocked) with cancel.
- Recurring schedules only after P2–P4 retention, permission, and concurrency proofs.
- Exit gate: e2e/component proof of list + cancel; cron behind an explicit flag.

## Non-goals

- Replacing long-horizon checklists with a generic job queue UI.
- Letting Plan Mode or hooks `asyncRewake` schedule work around the supervisor.
- Per-feature `setInterval` pollers in main as a permanent pattern.
- Broadening shell/MCP auto-run because a task woke while the app was unfocused.
- Cross-supervisor locking with external CLIs in v1 (dark-factory decision 14 still
  applies until revisited).
- Marketplace/plugin distribution (#1082) — orthogonal supply chain.

## Open questions

1. ~~Exact on-disk root: beside threads under the project dir, or a sibling `tasks/` tree
   with its own `COPSE_*` override for tests?~~ **Resolved in P1:** beside threads at
   `~/.copse/workspace/<projectId>/tasks/<taskId>/` (override via existing
   `COPSE_WORKSPACE_DIR` only). The literal `tasks` dir is reserved and must not collide
   with UUID thread dirs; `readThread` already skips dirs without thread `meta.json`.
2. Should `run_background` processes automatically register as supervised tasks in P2,
   or remain session-scoped until a consumer opts in? _(still open — P2)_
3. ~~For agent-turn handlers, is the wake payload a synthetic user message, a steering
   event, or a dedicated #1079 turn kind?~~ **Resolved in P3:** dispatch through the
   main-process `AgentDispatcher` machine-turn path, with a bounded synthetic
   continuation prompt, operation-id deduplication, turn-tree epoch checks, and the
   shared continuation budget. Stale/budget-exhausted wakes become blocked tasks rather
   than bypassing #1079.
4. How do SSH / remote execution targets (#942) appear in the permission snapshot when
   the wake fires after the workspace target changed? _(still open — P2; P1 stores
   `workspaceTargetKind` / `executionRoot` placeholders only)_

## References

- [#1081](https://github.com/copse-dev/agent-pane/issues/1081) — product tracker
- [#1078](https://github.com/copse-dev/agent-pane/pull/1078) — Grok Build comparison
- [#558](https://github.com/copse-dev/agent-pane/issues/558) — long-horizon execution
- [#1015](https://github.com/copse-dev/agent-pane/issues/1015) — A2A / remote delegation
- [#1079](https://github.com/copse-dev/agent-pane/issues/1079) — headless turn contract
- [#1080](https://github.com/copse-dev/agent-pane/issues/1080) — Plan Mode / rewind (non-overlapping)
- [`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md) — first major sensor consumer
- [`execution-runtime-security.md`](execution-runtime-security.md) — capability / audit model
