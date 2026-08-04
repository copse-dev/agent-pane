# Project automations

This plan defines the first local prototype of Copse automations. It is a thin,
explicitly limited slice of the durable background supervisor proposed in
GitHub issue #1081 and the local/cloud split proposed in #875.

## Prototype: local cron → agent task

An enabled, project-scoped schedule contains a name, five-field cron expression,
prompt, and selected model. While the desktop app is running, a matching minute
creates a new thread in that project's filesystem-native thread store. The new
thread is model-pinned and the renderer submits its prompt as a new root agent
turn through the normal checkout and agent-run paths.

The schedule authorizes submission of the configured prompt, not broader tool
access. Normal permission policy remains in force: sandbox-contained commands
follow the user's current auto-run setting, and commands that require approval
still pause the scheduled thread and prompt. A checkout failure keeps the prompt
as an unsent draft; provider failures surface on the started thread, matching an
interactive submission.

The renderer currently owns interactive agent streams and transcript persistence.
Consequently, a task for the active project starts immediately; a task created for
an inactive project starts when that project is next opened. True headless execution
while no renderer owns the project belongs to #1081's durable supervisor and #1079's
shared turn contract rather than a second automation-specific runtime.

Prototype boundaries:

- local machine and local wall-clock time only;
- Copse must be running;
- standard five-field cron, evaluated once per minute;
- no missed-run catch-up, retry/backoff, concurrency policy, or process recovery;
- no webhook/event triggers;
- no headless execution for an inactive project or closed renderer.

The minute clock is now a durable recurring task owned by #1081's shared supervisor;
the schedule/IPC shape remains an Automations consumer. Pack disablement cancels the
operational scheduler task while preserving schedule configuration; re-enabling creates
one replacement owned by an enabled schedule's project.

## Pack boundary

`copse.automations` is a default-off first-party pack. The pack owns atomic
enablement, a level-3 `settings-pack-detail` UI declaration, and its namespaced
storage declaration. Host code owns the clock and thread-store write; renderer
code owns the project/model-aware editor and dispatches due prompts through the
existing interactive agent controller. This follows the two-capability-tier
decision in `hooks-and-feature-packs.md`: a user pack cannot ship an in-process
scheduler or arbitrary renderer code.

Disabling the pack stops new triggers but preserves schedules and already-created
threads. History never consults live pack registration (decision 17).
