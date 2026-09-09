# Event automation inbox: first implementation

Implements slice A of the [event-driven automation proposal](https://github.com/copse-dev/agent-pane/pull/2594).
This is an internal admission and recovery boundary, exercised with an injected
adapter and durable filesystem fixtures. App startup does not install it yet. It
adds no UI, connection, polling timer, webhook endpoint or model execution.
Existing cron schedules and the supervisor's one-shot `emitEvent(string)` remain
unchanged.

## Implemented contract

`AutomationEventInbox.admit` validates normalized source evidence against a
host-owned projection of a saved definition. The source cannot select the
workflow, model, instructions, permissions or execution path. Unknown fields are
rejected. Project, repository, source, event type and authenticated connection
must agree with the definition and registered adapter. A definition revision is
required so an in-flight poll cannot adopt an edited definition accidentally.
Automation-originated events are filtered by default, including cross-automation
chains. Filtered deliveries retain an explanation.

Admission persists a receipt before returning; it does not enqueue. A polling
adapter must advance its durable cursor only after this acknowledgement.
`reconcile(projectId)` claims admitted receipts with a deterministic run identity
and calls `TaskSupervisor.enqueueOnce`. Claims and queue writes can be retried
after interruption without creating another task. The same identity becomes the
thread ID at the injected draft-preparation boundary. Supervisor tasks retain
normal concurrency accounting, cancellation, audit and a three-attempt recovery
limit. A reported preparation failure is fenced, not automatically retried.

`enqueueOnce` compares the caller's content fingerprint, handler and thread ID
against existing metadata, including archived tasks. Corrupt or missing metadata
in an existing task slot is an error; it is never interpreted as permission to
create another run. Callers must hash all immutable execution input into the
fingerprint. The inbox hashes its entire normalized delivery and saved binding.

Before enqueue and again inside the handler, the inbox rechecks the saved
binding, plugin availability, adapter matching, resource freshness and the host's
permission/limit decision. A changed definition, unavailable project or denied
check permanently fences this receipt. A future explicit retry must create a new
manual identity; re-enabling the plugin does not replay fenced work.

## Storage and host responsibilities

Receipts live under
`~/.copse/workspace/<projectId>/event-inbox/<sha256>.json`, following the normal
`COPSE_DIR` / `COPSE_WORKSPACE_DIR` overrides. Identity includes the project,
automation, saved revision, authenticated source/connection and normalized
delivery ID. The immutable evidence and mutable disposition are atomically
replaced in one file. The file is flushed before rename; this covers interrupted
process writes, not a cross-process database or a power-loss transaction.

For this slice, redacted payload evidence is **inline**, capped at 64 KiB UTF-8,
and hashed. Structured facts are bounded to 32 scalar entries with bounded keys
and string values. Keeping evidence in the same atomic receipt avoids introducing
a missing-blob recovery case before there is a real source. Blob extraction and
retention must preserve the receipt's deduplication identity in slice B; do not
expire that identity while the source can replay the delivery. No automatic
receipt deletion ships here.

The host must:

- Register the inbox handler before starting the supervisor, using a real,
  authenticated adapter and a stable saved-definition projection. The projection
  includes the original permission snapshot; it must not mint a new `capturedAt`
  on every read. This implementation registers one adapter per supervisor.
- Supply side-effect-free matching and authorization checks. Connection scope,
  resource freshness and run/worktree budgets belong to those checks. Authentication
  and upstream replay-age checks belong to the source adapter.
- Prepare drafts idempotently with the supplied run/thread ID, checking the saved
  definition under its writer lock and the abort signal at the commit boundary.
  Preparation must not run a model or perform external writes. A crash can call
  this boundary again after the draft already exists.
- Mark the plugin/definition unavailable, then await `fence` before completing
  disablement or deletion. Admission and lifecycle fencing share a serialization
  lock. Stop source subscriptions as part of the same host lifecycle. Fencing only
  cancels pending preparation tasks; already-prepared user tasks are untouched.
- Run reconciliation on startup and after durable admission. Single-app ownership
  follows the existing supervisor/store model; multiple independent processes
  must not write the same profile.

No production setting or manifest capability is introduced only for tests. Slice B
will supply the saved-definition writer, real authenticated CI polling, app-open
turn dispatch, coalescing and cost/worktree budget enforcement. Those are required
before exposing event automations in the shared modal/Settings editor. This slice
makes no claim that a stored permission snapshot authorizes later tool use.

## Acceptance criteria and evidence

The proposal's slice A criteria are:

- Duplicate delivery, including after restart, produces one run identity.
- Crashes between inbox write, claim, enqueue, and thread creation recover that run.
- Invalid source, target, payload bounds, and definition revision cannot dispatch.
- Disablement/deletion fences pending work while preserving historical records.

`event-inbox.test.ts` exercises these against the real filesystem inbox and real
supervisor/task store, injecting failures after persistence and interrupting a
handler after its durable thread fixture is written. It also covers concurrent
admission/fencing, changed evidence, UTF-8 payload limits, causal-loop rejection,
failed preparation and terminal-state preservation.
`task-supervisor-idempotency.test.ts` covers concurrent enqueue, archived identity,
conflicting input and corrupt/missing identity records. These are invisible
main-process changes, so no renderer visual eval is required.
