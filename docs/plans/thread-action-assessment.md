# Thread action assessment

Base: `9c5e3d9849c2`. Scope: automatic, advisory assessment and a Needs action thread sort. No thread revival, prompts, approvals, or plugin execution. Plugins may consume the same read-only structured snapshot in a later integration.

Acceptance criteria:

- Pending approval/question signals sort first. Ambiguous work is judged against the conversation; dirty files and unread replies alone do not establish unfinished work.
- Existing threads are assessed gradually, including threads without changes or todos. Progress distinguishes unassessed and uncertain from no action remaining.
- Assessments and attempted evidence fingerprints survive restart. Opening the sidebar, reading a thread, changing its title, and writing a verdict never cause another model call for the same evidence.
- New turns/results invalidate the relevant assessment. In-flight results cannot overwrite newer evidence. Uncertainty is terminal for that snapshot; failures do not create retry loops.
- One assessment runs at a time with bounded input, timeout, and a persistent hourly call/input budget. Onboarding resumes after restart.
- The feature never starts agent work. The signal includes its evidence revision and reason.

Implementation: use the existing small-tasks route and usage ledger, persist a separate schema-validated assessment ledger under the Copse profile, and expose a read-only snapshot to the thread browser. Existing approvals/questions remain authoritative runtime signals.

Validation: focused assessment/sorting/component tests, a WebdriverIO screenshot of the sort and onboarding state, oracle, and the full `pnpm run check` (persistence and IPC changes).
