# Plan Mode and prompt-boundary rewind

Tracking: [#1080](https://github.com/copse-dev/agent-pane/issues/1080)

**Status: Active (P1 in progress).** Design contract landed on `main` via
[#1138](https://github.com/copse-dev/agent-pane/pull/1138). P1 adds the on-disk
plan artifact layout, zod/JSON Schema, and spine `plan` lifecycle events (fixtures
validate; no UI). Later PRs should link here and keep the working brief (#35),
long-horizon checklists (#558), and thread worktrees (#869) as
**foundations/consumers**, not alternate planning or history systems.

Parent investigation: [`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md).
Related durable state: [`../thread-store-format.md`](../thread-store-format.md),
[`thread-worktrees.md`](thread-worktrees.md). Capability/enforcement boundaries:
[`execution-runtime-security.md`](execution-runtime-security.md),
[`command-sandboxing-routing.md`](command-sandboxing-routing.md), and
[`hooks-and-feature-packs.md`](hooks-and-feature-packs.md).

## Why this plan exists

Copse already has several "plan-like" surfaces, but none is the user-facing
transaction Grok Build aims at: explore without mutating, write a reviewable plan
artifact, collect inline feedback, approve a revision, then start implementation as a
new turn.

| Surface                        | Role today                                  | Gap versus transactional Plan Mode / rewind                               |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------- |
| Working brief (#35)            | Auto-derived parent goal for the agent      | Explicitly not user-facing Plan Mode; no approval transition              |
| Roadmap plans / OKF notes      | Cross-task or product planning              | Not a per-turn exploration→implementation transaction                     |
| Long-horizon checklists (#558) | Execution tracking after a goal is accepted | Downstream of Plan Mode; must not own planning capabilities               |
| Thread store spine + OKF       | Append-only conversation history            | No user-visible prompt-boundary checkpoint or restore preview             |
| Per-thread worktrees (#869)    | Checkout isolation for parallel edits       | Needed for workspace restore; does not define rewind semantics            |
| Diff queue / backups           | Staged edits and recovery aids              | Not a prompt-boundary checkpoint that pairs conversation + checkout state |

#1078's ownership map assigns this product contract to #1080. This plan defines the
binding decisions, minimum contract, and the smallest design→implementation sequence.

## Binding decisions (do not reopen lightly)

1. **Plan Mode is a capability profile, not prompt text.** While planning, file
   mutations, mutating MCP tools, background launches, git writes, and write-capable
   child agents are unavailable at the registry/runner boundary. Shell is either
   read-only by construction or separately approved — redirection and arbitrary
   programs must not bypass an edit-tool block (see "Plan Mode bypasses" in the Grok
   Build comparison).
2. **Plan Mode ≠ working brief ≠ long-horizon.** The working brief remains automatic
   parent-goal context (#35). Long-horizon checklists manage accepted execution (#558).
   Plan Mode owns the explore → reviewable plan → approve → implement transition only.
3. **The plan is a durable, versioned artifact.** Inline comments and revision history
   live with the thread (readable files + spine events), not only in model context.
   Approval records the exact plan revision and chosen execution profile.
4. **Implementation starts a new turn.** Material deviations after approval link back to
   the approved plan revision; they do not silently rewrite the plan artifact.
5. **Rewind is prompt-boundary only.** Checkpoints are created at user-prompt
   boundaries (and other explicitly documented safe points). Each checkpoint records
   canonical event position, checkout identity, HEAD/index/worktree state, and
   recoverable vs non-recoverable external effects.
6. **Rewind never lies about irreversibility.** Restore previews list affected files and
   explicitly name effects that cannot be undone (API calls, pushed commits, remote MCP
   mutations). Local spine/checkout restore must not claim those were reversed.
7. **No second history.** Rewind and Plan Mode use the filesystem-native thread store
   and existing checkout ownership (#869 / `execution-runtime-security.md` checkpoint
   ideas). They must not invent a parallel event log or "plan-only" memory store.
8. **#1068 stays binding.** Active-task state remains authoritative in the thread;
   plan artifacts are thread-owned. Do not copy plan drafts into durable project
   knowledge unless the user explicitly promotes them.

## Minimum contract

### Plan Mode lifecycle

| Phase          | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| Enter          | Thread (or turn) switches to the planning capability profile; UI/host shows planning state |
| Explore        | Agent may read/search and (if allowed) run read-only or separately approved shell          |
| Draft          | Agent writes/updates a versioned plan artifact with stable identity + revision             |
| Review         | User (or reviewer) leaves inline comments; agent may revise → new revision                 |
| Approve        | User approves a specific revision + execution profile; record is durable                   |
| Implement      | New turn under an implementation profile; tools re-enabled per profile                     |
| Exit / abandon | Leave Plan Mode without approval; draft revisions remain inspectable history               |

### Plan artifact

On-disk layout under the thread root (Open Q1 resolved — not OKF conversation
messages):

```
<threadId>/plans/<planId>/
  meta.json
  revision-<n>.md
  comments.json
  approval.json          # only after approve
```

Minimum fields (zod in [`plan-schema.ts`](../../src/shared/threads/plan-schema.ts);
JSON Schema mirror [`schemas/copse-plan.schema.json`](../../schemas/copse-plan.schema.json)):

- `planId`, `revision`, `threadId`, `createdAt`, `updatedAt`
- `title`, `body` (markdown in `revision-<n>.md`), optional structured steps
- `comments[]` keyed to ranges or anchors in the body
- `status`: `draft` \| `approved` \| `superseded` \| `abandoned`
- `approvedAt` / `approvedRevision` / `executionProfileId` when approved
- content hash (sha256 of body) for integrity at approval time

Spine events use `type: "plan"` with
`action: create | revise | comment | approve | abandon` (see
[`thread-store-format.md`](../thread-store-format.md)).

### Capability profile (planning)

While `planning` is active:

| Capability                       | Default                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `read_file` / search / list      | Allowed                                                         |
| File write / apply diff / delete | Denied at registry/runner                                       |
| Mutating MCP                     | Denied (ignore `readOnlyHint` self-declaration as authority)    |
| Background task launch           | Denied                                                          |
| Git mutating commands            | Denied or require explicit non-planning escalation              |
| Shell                            | Read-only construction **or** always prompt; no silent escape   |
| Write-capable subagents          | Denied; explore-only children may be allowed under same profile |

Entering implementation clears or replaces this profile; it does not rely on the model
"promising" to stop editing.

### Prompt-boundary checkpoints

A checkpoint captures at least:

- spine position (last committed `events.jsonl` offset / event id)
- thread meta snapshot pointers needed for restore (working brief, todos, model, etc.)
- checkout mode + identity (shared vs worktree; branch; HEAD; dirty summary)
- optional worktree/index snapshot reference when #869 isolation is active
- `irreversibleEffects[]` observed since the previous checkpoint (best-effort: network
  MCP, `git push`, external APIs) — restore UI must surface these as non-undoable

### Rewind preview and restore

1. User selects a checkpoint (prompt boundary).
2. Host computes a preview: conversation truncation point, files that would change,
   checkout move, and irreversible effects that remain.
3. On confirm, restore conversation + local checkout through existing store/checkout
   APIs; mark later spine events as rewound (tombstone/branch policy decided in P2 —
   append-only honesty preferred over silent rewrite).
4. Failure policy: partial restore fails closed and reports which subsystem did not
   converge; never leave UI claiming a clean rewind when checkout restore failed.

## First delivery slices

**Design (on `main` via [#1138](https://github.com/copse-dev/agent-pane/pull/1138)):**
this plan (contract + phases + exit gates), index entry in [`README.md`](README.md),
and ownership link from the Grok Build comparison map.

**P1 (schema sketch):** on-disk `plans/<planId>/` layout, zod + JSON Schema, spine
`type: "plan"` lifecycle lines, fixtures under `tests/fixtures/plan-mode/`. No UI,
no `thread-store` writers, no capability-profile enforcement yet.

Still out of scope until later phases: Settings toggles, composer Plan Mode control,
plan markdown renderer, checkout snapshotter, and rewind UI.

## Later phases

### P1 — Artifact + schema sketch

- [x] On-disk layout: `plans/<planId>/{meta.json,revision-N.md,comments.json,approval.json}`.
- [x] Zod source of truth in `src/shared/threads/plan-schema.ts` + published
      `schemas/copse-plan.schema.json`.
- [x] Spine `type: "plan"` lifecycle actions (create/revise/comment/approve/abandon),
      preserved across full-save with artifact refs.
- [x] Fixtures under `tests/fixtures/plan-mode/` validate; no UI / no store writers yet.
- Exit gate: fixtures validate; no UI required.

### P2 — Checkpoint model on the thread store

- Specify prompt-boundary checkpoint records and their relation to `events.jsonl`.
- Decide append-only rewind markers vs branch/fork semantics for post-checkpoint events.
- Align with #869 checkout identity and `execution-runtime-security.md` R5 portable
  checkpoints (reuse fields; do not fork a second manifest).
- Exit gate: unit tests build/preview a checkpoint from a fixture thread without Electron.

### P3 — Planning capability profile enforcement

- Add a first-class planning profile at the tool registry / permission-gate boundary.
- Pin bypass tests: shell redirection, mutating MCP, write subagents, git writes.
- Exit gate: mock turn in Plan Mode cannot land a file edit or mutating MCP call.

### P4 — Approve → implement transition

- Wire approval to record revision + profile; start implementation as a new turn.
- Keep working-brief auto-updates (#35) from claiming Plan Mode duties.
- Exit gate: integration/unit test shows denied tools become available only after approve.

### P5 — Rewind preview UI + restore

- Desktop preview listing files, conversation cut point, and irreversible effects.
- Restore path through store + checkout APIs; headless/ACP may expose the same operation
  once #1079's turn contract can carry it.
- Exit gate: e2e/component proof of preview honesty + failed checkout restore messaging.

## Non-goals

- Replacing the automatic working brief with a mandatory planning ritual on every turn.
- Using Plan Mode as the long-horizon task runner or CI supervisor (#1081 / #558).
- Promising rewind of pushed commits, paid API side effects, or remote MCP mutations.
- A second durable conversation store for "plan sessions."
- Prompt-only "please don't edit files" as the enforcement mechanism.

## Open questions (resolve in P1/P2 PRs)

1. **Resolved (P1):** Plan artifacts live as `plans/<planId>/revision-N.md` (plus
   `meta.json` / `comments.json` / `approval.json`) under the thread root, with spine
   `type: "plan"` lifecycle lines. Not OKF conversation messages — those would pollute
   `parseSpine` / transcript fold.
2. On rewind, do we fork a new thread directory, tombstone events in place, or keep a
   restore branch pointer in `meta.json` while preserving bytes for audit?
3. Is explore-only shell a hard deny of all external/ambiguous commands, or a prompted
   path that still cannot write the workspace?
4. Does approving a plan always require an isolated worktree (#869), or is shared
   checkout allowed with a louder irreversible-effects warning?

## References

- [#1080](https://github.com/copse-dev/agent-pane/issues/1080) — product tracker
- [#1078](https://github.com/copse-dev/agent-pane/pull/1078) — Grok Build comparison
- [#35](https://github.com/copse-dev/agent-pane/issues/35) — working brief foundation
- [#869](https://github.com/copse-dev/agent-pane/issues/869) — per-thread worktrees
- [#558](https://github.com/copse-dev/agent-pane/issues/558) — long-horizon execution
- [#1068](https://github.com/copse-dev/agent-pane/pull/1068) — thread-state eval strategy
- [#1079](https://github.com/copse-dev/agent-pane/issues/1079) — headless turn contract (adapters may later expose rewind)
- [`../thread-store-format.md`](../thread-store-format.md) — spine / OKF layout
