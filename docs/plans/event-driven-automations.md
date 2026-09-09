# Event-driven automations

Status: **Implementation proposal. No event automation runtime ships with this document.**

Extends [Project automations](automations.md) and the authenticated-trigger phase of
[Background supervisor](background-supervisor.md#p6--campaigns--authenticated-trigger-adapters).
The existing cron prototype remains app-open and project-scoped. This proposal does
not turn a renderer-owned task into a headless worker.

## Product shape

Keep one Automations manager, reachable from the side cog and from a run's setup
action. The plugin owns the feature and its saved definitions; Settings owns global
plugin enablement and credentials. The manager and Settings share the editor.

An automation reads as **When → Conditions → Task → Limits**:

- **When:** on a schedule, when CI finishes, when a PR changes, or when an issue
  receives a selected label. Show only trigger types supplied by installed,
  enabled adapters with the required connection available.
- **Conditions:** repository, branch, selected checks or labels, and whether work
  created by automations is eligible. Start with structured controls rather than
  a free-form expression language.
- **Task:** the user's saved instructions, model rule, and project. Event text is
  attached as bounded source material, never substituted into system instructions.
- **Limits:** one active run by default, a retained-worktree cap, maximum run
  duration, and a finite run/cost allowance. Keep tool approvals on the existing
  permission path; saving a trigger is not approval for a later external action.

Before saving, show one plain-language sentence: “When CI finishes unsuccessfully
on a PR targeting main in this repository, investigate the failure. At most one
run per PR head and three runs per day.” A **Test match** action evaluates recent
events and shows what would match, without starting a model or changing files.

The list shows the trigger summary, enabled/paused state, and last outcome. Expand
an automation for recent deliveries and their linked tasks. Each delivery says
why it started, was filtered out, was coalesced, or needs attention. Keep task
history in the existing sidebar disclosure; do not add a permanent second run list
to the sidebar. Notify for completion with useful output, failure, or user action;
unchanged polling results stay quiet.

## First adapters, in order

| Adapter              | Concrete first workflow                             | Delivery identity and stale-work rule                                                                                                    |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CI completed         | Investigate a failed check suite on a selected PR   | Repository + PR + head SHA + check-suite/run ID + attempt; a new head supersedes pending work for the old head.                          |
| PR updated           | Review new commits after a PR leaves draft          | Repository + PR + head SHA + selected transition; ignore metadata-only edits unless explicitly requested.                                |
| Issue labelled       | Triage issues assigned an explicit automation label | Repository + issue + label transition ID; repeated polls do not create new work, but removing and reapplying the label is a new event.   |
| Local task completed | Produce a report after a user-started task          | Project + source task + terminal revision; ignore automation-originated tasks by default and retain turn-tree budgets for continuations. |

Start with CI completion through authenticated, app-open GitHub polling. Reuse the
existing CI-read and supervisor event-source machinery, sharing a source across
subscribers; do not create one interval timer per automation. The current
`emitEvent(string)` wakes one-shot waiters and carries neither a durable delivery
identity nor a payload. It is a wake signal, not the external event inbox described
below. Keep `wait_for_ci_checks`' existing continuation and stale-epoch semantics.

Unrestricted filesystem watchers are a later adapter: editor saves, generated
files, dependency installs, and an automation's own changes can cause storms.
Require explicit path filters, a quiet interval, origin attribution, and one
pending aggregate before adding them. Generic webhooks, ticketing, chat/mobile,
and security advisories follow the same ingress contract once it is proven.

## Ownership and plugin contract

The `copse.automations` plugin owns definitions, defaults, the editor declarations,
and its lifecycle. Trigger adapters declare stable source IDs, supported event
schemas, structured filter fields, required connection/capabilities, and delivery
normalization. The shared supervisor owns durable inbox admission, execution
queues, concurrency, budgets, cancellation, and audit records.

Do not add nullable webhook, label, or event fields to the existing cron-only
`AutomationSchedule`. Introduce a versioned workflow definition with a
discriminated trigger configuration when slice B has a real writer and runtime.
Migrate existing schedules losslessly to the schedule variant, preserving IDs,
prompts, model rules, cron expressions, enablement, and run history. The
supervisor envelope remains a separate immutable delivery record.

First-party adapters receive explicit host services. A selected user plugin must
use its existing validated, sandboxed runtime capabilities; a trigger declaration
does not grant network access, filesystem writes, arbitrary IPC, or the ability
to mount renderer code. Do not expose an unused generic `host.call` or let a
manifest self-promote its trust tier. An adapter not supported by a real runtime
must be rejected at registration instead of appearing as a usable trigger.

Disabling an adapter stops its sources and marks dependent automations unavailable.
Disabling Automations stops admission and fences queued deliveries; re-enabling
does not replay an unknown backlog. Already-running tasks retain their normal
stop control. Definitions and historical evidence survive disablement and removal.

## Durable delivery and execution

Normalize to an immutable, versioned envelope before any handler is selected:

- Source/adapter ID, authenticated connection identity, external delivery ID,
  event type/version, and observed/occurred timestamps.
- Repository/project target, resource ID and revision, bounded payload blob
  reference plus hash, and normalized structured facts used for matching.
- Automation ID plus saved-definition revision/hash, workflow/profile identity,
  origin/causation IDs, requested verification policy, and captured limits.

The source supplies event facts, not a replacement prompt, arbitrary project path,
model, tool grants, or a workflow name of its choosing. Validate target ownership
and connection scope against the saved definition. Credential bytes never enter
the envelope. Preserve enough redacted source evidence to explain the match and
support a later replay, with bounded retention.

1. Persist the envelope and matching result in the supervisor inbox. Polling
   advances a durable cursor only after that write. Webhooks acknowledge only
   after admission; verify signatures and replay age before admission.
2. Atomically claim `(automation ID, definition revision, normalized delivery ID)`
   while assigning a stable run ID. Enqueue an idempotent supervisor task bound
   to that run. Recover a crash between claim and enqueue by reconciling the
   claimed run, not by generating a new identity.
3. Recheck plugin enablement, project availability, saved-definition revision,
   resource freshness, and permission policy before dispatch. Definition edits
   hold older pending deliveries for review; they never execute a newly edited
   prompt under an older event's authorization. Deleted definitions remain terminal.
4. Apply limits before creating a thread or checkout. Event deliveries coalesce
   by resource/revision, with at most one pending newest delivery behind a running
   one. Never cancel a user's unrelated active task or overwrite a dirty checkout.
   Show superseded/coalesced dispositions rather than silently dropping events.
5. Create or recover the run's thread idempotently, with automation ID, delivery
   ID, trigger summary, and causation recorded. Dispatch through the shared turn
   contract. App-open mode waits visibly for the relevant project/renderer; a
   future detached runtime must use the same contract.
6. Record outcome, attempts, result references, spend, and intervention. Retry
   transient ingestion failures with bounded backoff and jitter. Do not retry a
   potentially completed external write merely because the response was lost.
   Explicit **Run again** creates a new manual run linked to the original delivery.

Exactly-once delivery is not assumed. Stable identities, idempotent admission and
actuation, and recovery tests are the guarantees. A same-automation causation
chain is rejected by default; cross-automation chains need an explicit opt-in,
finite depth, and shared run budget. CI caused by an automation's own PR must not
silently restart its producer indefinitely.

## Other improvements worth shipping independently

1. **Schedule presets and preview:** daily, weekdays, weekly, custom cron; show
   the next three local occurrences and timezone. Preserve custom expressions
   when switching editors and make daylight-saving behavior explicit.
2. **Run outcomes in the manager:** distinguish never run, starting, waiting for
   project, running, needs approval, succeeded, failed, and skipped due to limits.
   Link directly to the task and explain what unblocks it.
3. **Pause and duplicate:** pause one definition without editing its prompt;
   duplicate as a disabled draft so copying cannot accidentally double live work.
4. **Templates:** plugin-defined starting prompts and trigger defaults for CI
   investigation, issue triage, and docs freshness. Templates create editable
   definitions, not hidden hardcoded behaviors.
5. **Verification as explicit policy:** optional independent verification only
   with saved model/cost limits and a structured result contract. Never silently
   turn on extra billable model work.

## Reviewable implementation slices

### A. Inbox and idempotent run identity

No UI or source connection yet. Implement the supervisor admission/reconciliation
contract with an injected adapter and durable storage fixtures.

Acceptance criteria:

- Duplicate delivery, including after restart, produces one run identity.
- Crashes between inbox write, claim, enqueue, and thread creation recover that run.
- Invalid source, target, payload bounds, and definition revision cannot dispatch.
- Disablement/deletion fences pending work while preserving historical records.

### B. CI adapter and shared editor controls

Add one real authenticated polling adapter, explicit repository/check filters,
test-match preview, trigger summary, and linked run status. Keep it app-open until
the shared detached-turn contract is ready.

Acceptance criteria:

- A seeded failed CI transition matches once; identical polls remain quiet.
- A replaced head suppresses old pending work, and an automation's own output
  cannot recursively trigger it by default.
- Paused/unavailable adapters cannot enqueue or start a model turn.
- The modal and Settings use the same controls; focused visual tests cover new,
  paused, unavailable, preview, and waiting-for-project states.
- Approval prompts, worktree limits, and concurrency budgets apply through the
  normal execution path.

### C. Additional adapters and ingress

Add PR and issue-label adapters using the same envelope, then local completion.
Webhooks require the detached control-plane/worker and credential-verification
boundary; accepting a URL in the editor alone does not create reliable ingress.

Acceptance criteria:

- Each adapter supplies contract fixtures for duplicate, stale, malformed,
  unauthorized, and out-of-order events.
- Shared sources detach when their last enabled subscriber disappears.
- Every admitted or rejected delivery has a bounded, readable explanation.
