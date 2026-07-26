# Project automations

This plan defines the first local prototype of Copse automations. It is a thin,
explicitly limited slice of the durable background supervisor proposed in
GitHub issue #1081 and the local/cloud split proposed in #875.

## Prototype: local cron → draft task

An enabled, project-scoped schedule contains a name, five-field cron expression,
prompt, and selected model. While the desktop app is running, a matching minute
creates a new thread in that project's filesystem-native thread store. The new
thread is model-pinned and opens with the prompt as an unsent draft.

Creating a draft instead of immediately starting an agent turn is intentional:
the current interactive permission model cannot safely authorize delayed tool
work without a permission snapshot and re-approval policy. The user reviews and
sends the draft through the normal composer path.

Prototype boundaries:

- local machine and local wall-clock time only;
- Copse must be running;
- standard five-field cron, evaluated once per minute;
- no missed-run catch-up, retry/backoff, concurrency policy, or process recovery;
- no webhook/event triggers;
- no automatic agent/tool execution.

Those lifecycle concerns belong to #1081's shared durable supervisor. A later
implementation should keep the schedule/IPC shape as a consumer and replace the
in-process ticker rather than grow a second task lifecycle.

## Pack boundary

`copse.automations` is a default-off first-party pack. The pack owns atomic
enablement, a level-3 `settings-pack-detail` UI declaration, and its namespaced
storage declaration. Host code owns the clock and thread-store write; renderer
code owns the project/model-aware editor. This follows the two-capability-tier
decision in `hooks-and-feature-packs.md`: a user pack cannot ship an in-process
scheduler or arbitrary renderer code.

Disabling the pack stops new triggers but preserves schedules and already-created
threads. History never consults live pack registration (decision 17).
