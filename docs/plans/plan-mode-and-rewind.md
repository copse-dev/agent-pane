# Plan Mode and prompt-boundary rewind

Tracking: [#1080](https://github.com/copse-dev/agent-pane/issues/1080)

**Status: living plan workflow implemented; full static/unit and focused visual checks pass.** The optional
composer Plan control supports editable revisions, passage feedback, exact approval,
a new implementation turn, and criterion-level completion evidence. Prompt-boundary
rewind remains a later slice. Working briefs, execution todos and thread worktrees
remain separate foundations.

The [roadmap prototype](roadmap-plans.md#roadmap--living-plan-prototype-2026-09-26)
reuses this editor and opens the same task-owned plan from a roadmap item. Plan
actions now enter through the ordinary composer submission path so checkout
preflight, attachments and draft consumption behave consistently with Send.

### Current task brief

Review fixes: protect both new and saved drafts from accidental dismissal; accept
formatted required headings; retain complete multiline acceptance criteria in the
agent context and completion UI. Parse Markdown structure so fenced examples do not
become headings or criteria, and nested sections do not silently drop requirements.
Add component/store regressions and focused Electron assertions with screenshots,
then rerun the full local gate. Preserve document bytes and exact approval identity.

Rich-editor follow-up: replace the source textarea with an editable document and
compact formatting toolbar, with feedback beside the selected passage. Headings,
lists, emphasis, keyboard undo, source editing and read-only history must work;
opening or approving an unchanged document must preserve its exact Markdown bytes.
Passage anchors must still identify the selected occurrence in the saved revision.
Validate serialization/selection in component tests and real editing in Electron,
capture the new layout, and rerun the Markdown visual suite and full local gate.

Base: `bbbca7e30` (main synced on 2026-09-26). The risk surfaces are persisted
approval identity, renderer/main IPC, and agent tool/hook permissions; they require
the full local check plus focused Electron evidence.

Acceptance criteria:

- Quick tasks work without a plan. Clarification can show a recommended answer and reason.
- A plan has nonempty Goal, Constraints, Scope and Definition of done sections;
  bullet criteria have stable IDs within the approved revision.
- Saved revisions and passage comments survive reload. Stale writes and approval hashes fail closed.
- Draft turns advertise and enforce a strict built-in read-tool allowlist. Shell,
  MCP, custom tools, background work, executable todo checks and child agents are denied.
- Only the user can approve, while idle. Approval records the exact revision/hash
  and host-owned `implementation` profile; implementation starts a new human turn.
- Completion reports bind to that approval and cover each criterion exactly once
  with met, partial or unverified plus evidence. Missing reports display unverified.
- Interrupted writes cannot expose an uncommitted revision or approval; full thread saves preserve the artifacts.

Current boundaries:

- Copse-hosted provider models support this workflow. Container, ACP, remote and plugin-hosted
  executors fail closed while a plan is active because their native tools cannot
  be constrained by the Copse planning allowlist.
- Standalone review is unavailable during drafts; use the ordinary planning turn
  for read-only inspection. Container starts reserve the thread during preflight;
  plan edits also reject while a container is starting or running.
- Command hooks are denied at the host runner during drafts, including fail-open
  hooks. Blocking hooks may therefore stop a draft turn. Function hooks retain
  their canonical routing; no new continuation or hook event vocabulary is added.
- There is one current plan per thread. Approved revisions are immutable. End the
  current plan before creating a replacement; the new metadata links the previous
  plan via `supersedesPlanId`. Earlier artifacts remain in the thread archive.
- Completion is agent-reported evidence, not a host attestation that every assertion
  is true. Missing validation must be marked unverified. Rewind and automatic
  conversion of criteria to executable todo checks are outside this slice.

### Completion evidence (2026-09-26)

#### Review fixes

- New, unsaved plans now participate in dirty tracking: Escape preserves title and
  body edits, idle refreshes keep them intact, and closing explicitly offers discard.
- Required sections and acceptance criteria now share a Markdown lexer with the
  document editor. Formatted headings save without changing the stored body/hash;
  multiline items retain their full text. Nested criteria and subheadings stay in
  order, while fenced and quoted examples do not invent criteria. Inline code keeps
  significant spaces.
- The focused parser, store and editor run passed **339 tests**. The final Electron
  plan workflow plus the six Markdown specs passed **ten tests** across seven specs.
  This includes bold-heading save, Escape protection, approval, and the complete
  multiline criterion after reload. The build passed.
- The final `pnpm run check` passed every static gate and **11,066 tests**, with
  zero failures, skips or cancellations. This includes the additional inline-code
  whitespace regression.
- Inspected [new-draft protection](../../tests/e2e/screenshots/thread-plan-unsaved.png),
  [draft review](../../tests/e2e/screenshots/thread-plan-review.png) and
  [completion evidence](../../tests/e2e/screenshots/thread-plan-completion.png): the
  document and controls are readable, and the full criterion wraps in the sidebar.
- Broad Electron validation remains incomplete: the 321-spec headless run passed
  **14 specs**, then timed out in `acp-unfinished-turn-recovery.e2e.ts` setup. The
  isolated headless retry also timed out while ChromeDriver waited for the renderer.
  Running that same spec with `COPSE_E2E_HEADLESS=0` passed **all five tests** in
  23 seconds. The full headless suite is not a green gate; live inference and rewind
  remain outside the completed slice. Logs are under `.tmp/plan-fixes-*` locally.

#### Rich editor follow-up

- The default Document view now uses Tiptap for editable headings, paragraphs,
  emphasis, lists and inline code, with undo/redo and a Markdown source view.
  Feedback and completion evidence sit beside the document. Tables and task lists
  survive loading; image Markdown appears as a reference without a rendered image.
- Unchanged documents retain their original Markdown bytes, including reference
  links and emphasis spelling. Rendered selections map to the corresponding source
  occurrence before the existing revision-specific comment operation is called.
- `pnpm run check` passed every static stage; its first unit run found two stylesheet
  convention violations. After fixing those, `pnpm test` passed **11,060 tests**,
  zero failed/skipped/cancelled. The focused editor, dialog, accent-rail and typography
  run passed **27 tests**; formatting and `git diff --check` also passed.
- `pnpm run build` passed. The plan spec plus the six specs named by
  `test:e2e:markdown` passed **ten Electron tests**. The final plan spec was rerun
  after the stylesheet fixes: **three passed**, including keyboard undo, toolbar
  formatting/redo, source history, feedback, approval and persistence.
- The updated draft and completion screenshots linked below were inspected: all
  document sections, feedback/results and approval controls are readable without
  clipping. The broader Electron coverage gap recorded below remains open.

#### Initial workflow implementation

- `pnpm run check`: passed all static gates and **11,057 tests**, zero failed,
  skipped or cancelled. Includes stale writes, interrupted state commits, approval
  identity, concurrent plan contexts, draft tool/hook denial and execution-todo isolation.
- `pnpm run build`: passed on the synced base with the complete implementation.
- `node scripts/gen-api-protocol.mts --compare-ref HEAD`: passed; six additive
  surfaces and two conservatively classified event-shape changes, version 20 → 21.
- `pnpm run test:e2e -- --spec tests/e2e/thread-plan.e2e.ts --spec tests/e2e/ask-user-dialog.e2e.ts --mochaOpts.timeout=90000`:
  **seven tests passed** across both specs. Exercises user edits, passage feedback,
  prior revisions, agent refinement, approval into a new turn, completion reports,
  reload persistence, draft container/review rejection and recommended clarification.
- Visually inspected the captured [draft review](../../tests/e2e/screenshots/thread-plan-review.png),
  [completion evidence](../../tests/e2e/screenshots/thread-plan-completion.png) and
  [clarification](../../tests/e2e/screenshots/ask-user-dialog.png) screenshots.
- **Remaining validation gap:** the oracle selected broad Electron coverage. The
  pre-sync `pnpm run test:e2e -- --bail=1 --mochaOpts.timeout=90000` attempt passed
  11 specs, then stopped in `acp-tool-diff.e2e.ts` setup when ChromeDriver refused
  its localhost connection. That spec passed on retry; the complete 321-spec suite
  has not passed. Provider behavior was exercised through the existing mock-model
  boundary, not live inference. Rewind remains open under #1080.

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
  approval.json          # only after approve; convenience projection
  states/<eventId>.json   # immutable metadata/comments/approval/completion snapshot
```

Minimum fields (zod in [`plan-schema.ts`](../../packages/thread-store/src/plan-schema.ts);
JSON Schema mirror [`schemas/copse-plan.schema.json`](../../schemas/copse-plan.schema.json)):

- `planId`, `revision`, `threadId`, `createdAt`, `updatedAt`
- `title`, `body` (markdown in `revision-<n>.md`), optional structured steps
- `comments[]` keyed to ranges or anchors in the body
- `status`: `draft` \| `approved` \| `superseded` \| `abandoned`
- `approvedAt` / `approvedRevision` / `executionProfileId` when approved
- content hash (sha256 of body) for integrity at approval time

Structured steps keep `id` and `label` as their only required fields. Optional `dependsOn`,
`effort` (`low | medium | high`), `todoId`, and `expectedOutput` metadata lets a future writer
relate approved work to execution progress, express dependency edges, size routing, and name an
observable result without changing execution behavior. Existing P1 fixtures remain valid.

Spine events use `type: "plan"` with
`action: create | revise | comment | approve | abandon | report` (see
[`thread-store-format.md`](../thread-store-format.md)).

Every writer prepares the revision and a hashed state snapshot, then appends the
spine line as its commit point. Readers use only committed `state` and `artifact`
refs, validate identities and hashes, and ignore orphan files. `meta.json`,
`comments.json` and `approval.json` are repairable convenience projections, never
approval authority. Full thread saves retain both refs. Original P1 fixture lines
without state snapshots remain readable as history but cannot authorize execution.
UI writes check thread idleness again immediately before committing, preventing
approval races with a turn that starts while artifact writes are pending.

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
