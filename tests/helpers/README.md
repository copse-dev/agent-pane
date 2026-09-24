# Testing roadmap IPC writes without Electron

`roadmapWriteHarness()` in `roadmap-write-harness.ts` runs the same create/update
handlers registered by `registerAllHandlers`. Storage, attachments and background
model calls are injected at their I/O boundaries. Input validation and mutation
logic are the production implementation. No Electron process or live model key is
needed. Sender-frame authorization remains in the IPC registration and is covered
separately by `ipc-guards.test.ts`.

The harness exposes `handlers.create(...)`, `handlers.update(...)`, a `notes` map,
recorded `stamps`, and deleted attachment IDs. Seed an existing note by creating
one and replacing its stored value in `notes`. Assert returned/persisted behavior,
not source text. See `src/main/ipc/roadmap-write-handlers.test.ts` for examples.

Copse Reviewer can import the helper from a `.copse-review/` reproducer using
`../tests/helpers/roadmap-write-harness.ts` and execute it with `argv: ["copse-test"]`.
The test must exercise the same behavior on both revisions. If the base predates
this helper, a missing import is not a passing baseline or evidence of a product
regression; use another shared test boundary or report that limitation.
