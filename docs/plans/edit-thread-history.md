# Edit thread history

Status: Initial manual editing release implemented in this working tree. Follow-up hardening remains below.
Base inspected: `f05906bd5`.
Design reference: [interactive prototype](../../prototypes/edit-thread.html).
The prototype's browser spec is [edit-thread.demo.ts](../../tests/demo/edit-thread.demo.ts).

## Outcome and accepted scope

Let a user revise the conversation Copse uses for its next turn without starting a
different thread. Enter through **Fork → Edit thread history…**, using the current
Copse workbench layout. Normal Fork continues to create a new thread.

The first release includes direct editing of user/assistant prose, excluding
settled messages, reviewing the resulting history, applying it to the same
thread, and restoring the previous version through Undo. It does not regenerate
downstream replies, rerun tools, roll back files, or alter Git history.

The prototype's natural-language cleanup button is a scripted example. A general
AI-assisted edit-request feature is a later phase, not an existing capability to
wire up.

Observable acceptance criteria:

1. There is no standalone Edit button in the normal thread view. Both whole-thread
   Fork and per-prompt Fork expose the history editor through their Fork choices.
2. Per-prompt entry opens the entire history and focuses that message. It does not
   implicitly truncate later messages. Normal “Fork from here” keeps its current
   cut-at-message behavior.
3. In the six-message example, editing the first prompt and excluding the three
   abandoned-detour messages produces exactly the three reviewed messages.
4. The next model request uses that reconstruction, including after app restart.
   Cached history, an old ACP session, or a stale completion cannot reintroduce
   the excluded turns.
5. Cancel changes nothing. A conflicting update prevents Apply and preserves the
   user's draft for review. A failed commit never leaves a usable thread with
   mismatched transcript and model history.
6. Undo restores the previous transcript and usable model context while leaving
   workspace files, real tool side effects, and security decisions untouched.
7. Dark/light themes, keyboard navigation, narrow panes, large histories, and
   the actual Fork entry path have focused visual coverage.

## Implemented surface

| Surface                | Implementation                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fork UI                | Sidebar and per-prompt Fork actions now open a shared choice menu with **Fork a copy** and **Edit thread history…**. Normal Fork behavior is unchanged.                                                                                          |
| Draft editor           | `src/renderer/views/thread-history-editor.ts` keeps edits local, supports inclusion controls, focuses the prompt that launched it, and publishes only the committed main-process result.                                                         |
| Authoritative contract | `src/shared/threads/history-edit.ts` and `src/main/services/thread-history-edit.ts` bind Apply and Undo to a main-issued transcript revision, validate every message ID, preserve non-editable fields, and rebuild provider history in main.     |
| Runtime fence          | `src/main/services/agent-dispatcher.ts` owns an exclusive history-edit slot. Apply and Undo require an idle thread, invalidate cached native history, dispose the ACP session, clear its durable binding, and retire the old continuation epoch. |
| Persistence            | `packages/thread-store/src/thread-store.ts` journals the before-state before replacing transcript and provider history, recovers an interrupted edit before reads, and keeps one durable Undo snapshot.                                          |
| Context coverage       | Stored images and tool groups use the existing fork reconstruction. Retained legacy attachment and inline-paste inputs that cannot be reconstructed are identified per message and block Apply until excluded.                                   |
| IPC                    | Typed preload and IPC methods expose snapshot, Apply, and Undo. The renderer flushes pending transcript persistence before opening an authoritative snapshot.                                                                                    |

The storage contract is [thread-store-format.md](../thread-store-format.md).
Changes affecting continuation epochs or hook outcomes must obey
[hooks-and-feature-packs.md](hooks-and-feature-packs.md), particularly its
execution guidance, preserved audit records, and stale-epoch rules.

## Product behavior to implement

### Draft and review

Use the existing sidebar, conversation shell, fonts, semantic colours, spacing,
and composer conventions. The standalone HTML is a flow reference, not a renderer
component to embed.

Create an editor-local draft keyed by stable message ID and a main-issued source
revision token. Editable fields are message prose and inclusion. Roles, IDs,
timestamps, tool arguments/results, reasoning, usage, attachments, audit events,
and approvals are not arbitrary editable fields.

Keep retained messages in their original order. Excluding an assistant message
also excludes its tool-call/result group from active model history. Show that
effect before Apply. A tool-only assistant message is valid even without prose;
validation must be more precise than the prototype's non-empty-text rule.

Mark human-edited assistant prose as edited; retain its original authorship and
revision provenance. The preview shows the actual retained transcript and the
specific edits/exclusions, with original text available for comparison.

Apply is available only with a real change and at least one reconstructible
message. The normal composer draft survives entry, cancellation, and completion.
Warn about discarding unsaved edits when leaving the editor.

### Eligibility and concurrency

Allow commits only when the thread is quiescent. Enforce this in main, not just
through a disabled renderer button. Include active native/ACP runs, descendant
agents, pending approvals, queued follow-ups, supervised work that can deliver
back into the thread, and cloud/container imports in the ownership audit.

For the first release, require the user to resolve an outstanding queue or
active work through existing controls. Opening Edit must not automatically stop
agents, release held messages, or consume approvals. Unsupported externally owned
threads get an explicit unavailable reason; ordinary Fork stays available.

A draft can become stale while open. Apply rechecks ownership and the source
revision inside an exclusive thread mutation operation. Return a conflict rather
than overwriting newer state. Preserve the draft so the user can compare/reopen.

### Undo

Keep a durable previous-version snapshot. Offer Undo while the current transcript
still matches the committed edit result and the thread is quiescent. A new turn,
a new edit, or another transcript mutation ends that immediate Undo opportunity;
a benign title or composer-draft change should not.

Undo uses the same validation, commit, recovery, and runtime invalidation path as
Apply. Restore conversational state, not external ACP session IDs, old permission
grants, pending tool execution, or old continuation authority. Mark the restored
revision as a new state so stale work still fails its revision check.

A full revision-history browser and arbitrary undo across subsequent turns are
outside the first release.

## Implementation sequence

### 1. Define the mutation contract and context inventory

Add a shared schema for message operations: `messageId`, optional replacement
prose, and inclusion/exclusion. Bind requests to project/thread ownership, an
expected source revision, and an operation ID for idempotent retries. Validate
size limits, duplicate/unknown IDs, ordering, and allowed message types with the
repository's decoders.

Proposed APIs:

- Preview: read the authoritative source, validate draft operations, and return
  the resulting transcript, context-coverage findings, and revision token.
- Apply: revalidate the same operations/token and commit the new revision.
- Undo: restore the eligible previous revision against an expected current token.

Do not accept a renderer-authored full Thread object or raw provider history as
the authoritative replacement. Main reconstructs from existing messages and
validated edits, preserving non-editable fields.

Inventory every writer and context consumer before finalizing the schema:
renderer autosave, dispatcher checkpoints, ACP updates, remote imports, task
deliveries, exports, thread references, and derived catalog/PR caches. Keep the
revision token sensitive to all reconstruction-relevant state, rather than
relying on millisecond timestamps alone.

Deliverable: shared schemas, pure edit transformation, coverage assessment, and
contract tests. These form the input to the persistence and runtime work.

### 2. Add recoverable storage and revision snapshots

Implement a dedicated history-edit operation in `@copse/thread-store`, with the
host orchestration in a new `src/main/services/thread-history-edit.ts`.

Use the existing store write serialization, but add a recoverable multi-file
commit protocol. A recommended shape is a small versioned transaction journal
with staged before/after state and an atomic commit marker:

1. Validate the source revision under the mutation fence.
2. Durably stage the previous and replacement transcript/history state.
3. Record the pending transaction before replacing any live files.
4. Replace the live transcript, affected metadata, and provider history.
5. Atomically mark the transaction committed; only then acknowledge success.
6. Recover an uncommitted transaction to the previous state before any thread
   read or dispatch; complete/reconcile a committed transaction to its new state.

Test and settle the precise journal layout in this phase. Separate atomic file
writes or a try/catch rollback alone do not provide crash recovery.

Snapshot all referenced content needed for Undo, including excluded message text,
tool results, and images. Make snapshots self-contained or explicitly pin their
blob references against store cleanup. Preserve non-message and unknown spine
lines, including hook, approval, plan, and machine-continuation audit records.
Update catalog digests and invalidate derived transcript indexes.

Use operation IDs to handle double-clicks, lost IPC replies, and retries without
creating multiple revisions. Keep unresolved recovery failures fenced with a
clear error. Update the on-disk format and export/import compatibility docs in
the same change. Define snapshot retention and cleanup before shipping; retain
at least the currently eligible Undo snapshot.

### 3. Coordinate runtime context replacement

Introduce a temporary history-mutation fence/lease in the dispatcher ownership
path. Claim it before awaiting work so a new human turn, machine wake, or external
import cannot start between the idle check and commit. Do not repurpose the
permanent deletion fence or call thread deletion cleanup.

Under that fence:

- Flush/settle earlier persistence and verify no live checkpoint writer can still
  commit old history.
- Rebuild native provider history using the same transformation as partial Fork.
- Invalidate native in-memory history only in coordination with durable state.
- For ACP, dispose the pooled session without resume, clear carry-over candidates,
  and clear `acp-session.json` even if the live pool is already empty. The next
  submission must open a genuinely fresh session and replay the edited context.
- Coordinate remote/container ownership. An executor without a proven context
  replacement path remains ineligible instead of silently retaining old memory.
- Advance the context revision and reject or hold pre-edit async deliveries
  according to the existing stale-epoch contract. Apply must not schedule a new
  agent turn or reset continuation budgets as an incidental side effect.

ACP invalidation and storage recovery must agree across crashes. Record enough
revision/generation state that a restart cannot pair a committed edit with an
old durable external session binding. If disposal cannot establish that an old
session has stopped, do not publish success.

Audit indirect context:

- Recompute/invalidate the working brief and any derived goal that still refers
  to edited or excluded turns.
- Retire stale todo/review steering from the next model payload while retaining
  historical plan/review records. Preview any user-visible task-state effect.
- Recompute context-fill estimates; keep historical usage and compaction audit
  records rather than presenting old estimates as current.
- Invalidate relevant tool-result/session caches; preserve actual workspace,
  worktree, Git, billing/usage, and permission facts.

This is the critical path. A successful disk edit with stale model/session
context is not a successful feature.

### 4. Wire typed IPC and renderer persistence

Add decoded handlers alongside `threads:fork` in
`src/main/ipc/register-handlers.ts`, with matching preload and API types. Check
sender and project/thread ownership as existing thread operations do.

Add a small renderer controller for preview/apply/undo. Flush pending writes
before taking the edit source, keep draft changes out of the live AppStore, and
publish only the main-returned committed state. Synchronize the persistence
baseline so a debounced old meta/message write cannot overwrite the new revision.

Return distinct busy, stale-source, unsupported-context, and persistence failures.
Keep the draft and review state on failure. On a lost reply, query the operation's
committed result rather than blindly applying again.

Deliverable: one fully working native plain-text edit through IPC, including
restart and Undo, before expanding the editor's supported content.

### 5. Build the production UI in the existing shell

Use one shared Fork-action helper from the sidebar and user-message actions:

- Fork thread / Fork from here: existing behavior.
- Edit thread history…: open the editor on the same thread.

Keep Edit off the ordinary header and message action row. Reuse the context-menu
primitive for the choice list; only extend it narrowly if keyboard/focus behavior
requires it.

Build a dedicated history-edit view/controller rather than growing the already
large conversation module. Include an editable transcript, inclusion controls,
a focused change/result preview, Apply, Cancel, and the revision/Undo notice.
Preserve the normal shell and follow current tokens, not the prototype's inline
styles. Lazy-render or otherwise bound large histories without losing edits when
rows leave the viewport.

Make loading, ineligible threads, conflicts, attachments that cannot be rebuilt,
failed commits, and discard behavior concrete states. Restore focus to the Fork
entry when exiting. Test menu keyboard navigation and editor labels.

### 6. Prove content coverage and ship

The current rebuild retains stored image payloads and tool-call/result structure,
but attachment-chip contents and inline-paste payloads may have existed only in
the original run payload. Re-reading a file today would not recover its original
contents.

Add a per-message reconstruction assessment before enabling Apply. Preserve all
recoverable payloads. For legacy retained messages with unrecoverable attachment
or paste content, block Apply with the affected message identified and a route to
exclude/replace that input or leave the source unchanged. Do not silently present
a complete reconstruction while dropping that content. Whether to offer an
explicit “continue with reduced context” option is a later product decision;
it is not the default in this plan.

Verify the supported native and ACP paths end to end before enabling them.
Document unsupported remote/provider combinations through the same capability
result used by main and the UI.

## Validation and release gates

Use Node 24.20.0 and pnpm 10.34.5 as pinned in the repository.

| Tier             | Required evidence                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure/unit        | Edit/exclude transforms; stable IDs; correct tool grouping; stored images; missing attachment/paste detection; duplicate/unknown IDs; empty/tool-only messages; revision conflicts; human-edit provenance.                                                                                                                                                                  |
| Store            | Apply and Undo round trips; audit/unknown-line preservation; catalog and blob retention; idempotent retry; injected failure/crash at every journal boundary; restart recovery before reads and dispatch.                                                                                                                                                                    |
| Runtime          | Stale cached history replaced; checkpoint races rejected; no auto-run; old task deliveries rejected/held; no budget reset; ACP new session used even after idle reap/restart; durable bindings invalidated.                                                                                                                                                                 |
| Component        | Actual Fork choices enter the editor; plain Fork still works; draft isolation; preview; busy/error/conflict states; persistence-baseline update; Undo eligibility; focus and keyboard handling.                                                                                                                                                                             |
| Browser geometry | Dark/light and narrow/wide editor states, long messages/history, menu placement, readable tool/attachment warnings, and screenshots.                                                                                                                                                                                                                                        |
| Electron e2e     | Start at the real Fork entry. Test Apply → Undo, including restart before continuation. Separately test Apply → next prompt and restart/resume, assert the provider's actual input, and verify that immediate Undo expires after the new turn. Include ACP lifecycle coverage through the existing adapter boundary and a focused real-agent check before claiming support. |

A seeded transcript that starts after Apply does not prove the feature. Assert
both what the user sees and what the next provider/ACP session receives. Inject
failures at real storage/transport boundaries; do not add test-only product flags.

Expected commands as implementation lands:

- `pnpm test -- thread-history-edit` plus focused fork, dispatcher, persistence,
  and ACP suites for changed behavior.
- `pnpm run oracle -- --explain` and its selected focused tiers.
- `pnpm run build`, the focused browser spec via `pnpm run test:demo --spec …`,
  and the focused Electron spec via `pnpm run test:e2e -- --spec …`.
- Full `pnpm run check`: mandatory because this affects persisted data, IPC, and
  agent lifecycle. The low-risk fast path does not apply.
- Prefer the configured remote e2e runner where appropriate; use the documented
  spare macOS real-agent workflow for authenticated ACP verification.

Implemented evidence:

- The 63 focused unit and component tests pass with
  `pnpm test -- thread-history-edit agent-dispatcher thread-fork message-fork-resend projects-pane-rename-archive`.
  They cover the dispatcher fence, authoritative revision check, same-thread
  transcript/provider replacement, durable Undo, interrupted-write recovery,
  unsafe attachment blocking, Fork placement, and renderer draft behavior.
- `pnpm test -- custom-properties thread-history-editor`: 5 tests pass after the
  final stylesheet change.
- The focused Electron spec enters through the real sidebar Fork menu, edits and
  excludes messages, applies to the same thread, saves visual evidence, reloads
  the app, and confirms that the reconstruction persisted: 1 passing.
- `pnpm run build` and `pnpm run check:local` pass. The complete `pnpm run check`
  reached and passed its static phase; the all-unit phase cannot complete in the
  workspace sandbox because existing SSH, VNC, egress, and sandbox-runtime tests
  require Unix sockets, loopback listeners, or paths outside the workspace.

Remaining hardening:

- Add idempotent operation IDs and a committed-result lookup for a lost IPC reply.
- Expand crash injection to every journal boundary and add explicit stale async
  delivery/import coverage.
- Assert the next native provider input and a fresh ACP session through their
  adapter boundaries, including restart and Undo expiry after a new turn.
- Recompute or retire stored working briefs, todos, and review steering after an
  edit. The initial release clears context estimates and continuation authority
  but preserves those records.
- Add light-theme, narrow-pane, keyboard/focus, and large-history visual cases;
  the first implementation renders the full history without virtualization.
- A natural-language cleanup request remains a separate follow-up.

## Delivery and effort

Implement in dependency order: contract → storage/recovery → runtime ownership
and session invalidation → IPC/persistence integration → UI → end-to-end matrix.
Storage and runtime coordination are the largest pieces; placing the menu and
building the editor are smaller.

Use reviewable changes under one owning feature issue. Intermediate changes
must not expose a working-looking editor until the commit and runtime paths
are correct. Apply the repository's one-issue/one-PR guidance when splitting
independently scoped tasks; keep the owning issue open until all acceptance
criteria are met.

An optional follow-up can turn a natural-language edit request into a validated
draft. It should propose exactly the same edit operations and require the same
review/Apply step, with no direct persistence, tool execution, or permission
changes. Add it only after the manual path has reliable recovery and context
coverage.

Before implementation, resolve the technical inventory in phase 1 and finalize
the revision journal layout and retention policy. These are implementation
decisions within this plan. A full revision browser, automatic reply
regeneration, arbitrary tool-result editing, and workspace rollback are separate
features and should not be folded into this change.
