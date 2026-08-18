# Measuring how long it takes to open a project

Debug-branch instrumentation for the reported symptom: _opening Copse on a large
project (Copse itself) takes a long time; a small project opens fast; switching
back to the large one is slow again._

Everything here is inert unless `COPSE_PERF=1` is set.

## Why the existing diagnostics were not enough

`event-loop-watchdog` and `startup-budget` measure boot phases that end at
`boot-complete`, which is roughly "the window exists and handlers are
registered". The cost the user feels lands _after_ that, in three places at once:

- renderer IPC (`workspace:set`, `threads:loadProject`, git and file-tree calls),
- main-process disk work (the thread-store fold, file indexing),
- and contention between them on main's single event loop.

None of that is attributable from a phase timeline, and a project switch has no
boot phases at all.

## What was added

| Piece                                                 | Where                            | What it answers                                                |
| ----------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| `perf-trace.ts`                                       | `src/main/services/diagnostics/` | Spans, marks and counters → NDJSON on one wall-clock axis      |
| `perf-ipc.ts`                                         | `src/main/services/diagnostics/` | Patches `ipcMain.handle` once: every channel timed and counted |
| `perf-bridge.ts`                                      | `src/preload/`                   | Patches `ipcRenderer.invoke`: renderer-**observed** latency    |
| `perf.ts`                                             | `src/renderer/`                  | Marks the boundaries of user-visible actions                   |
| `store:read-project-threads`, `store:thread-prefetch` | `thread-store.ts`                | Cost of reading a project's whole chat history                 |
| `index:build`                                         | `workspace-indexing.ts`          | Cost of listing the workspace tree                             |
| `storage:get` / `storage:set` counters                | `storage/storage.ts`             | Whether config reads have become an N+1 again                  |

Two numbers per channel matter and they are different. Main-side time is how long
the handler ran. Renderer-observed time is that plus queueing behind other main
work plus structured-clone of the payload in both directions. **The gap between
them is the signal**: a large gap means contention or payload size, not a slow
handler.

Records carry phase names, durations and counters only — never prompts, file
contents, or full paths (`pathLabel` reduces a path to its last two segments).

## Running it

Cold open, against the real profile (the size of that profile _is_ the variable
under study, so a synthetic one measures nothing):

```bash
COPSE_PERF=1 COPSE_PERF_OUT=/tmp/copse-open.ndjson pnpm start
```

Quit the app normally so the trace flushes, then:

```bash
node scripts/perf-report.mts /tmp/copse-open.ndjson
```

`scripts/perf-open.mts` wraps the launch/quit/report loop for repeat runs.

To measure a **switch** rather than a cold open, leave the app running with the
flag set, click between projects, then quit and report: `switch:activate` and its
three children (`switch:workspace-set`, `switch:load-threads`,
`switch:apply-state`) bracket exactly one click.

## Reading the report

- **Timeline** — named phases in order. `renderer:boot` is the end-to-end open.
- **IPC channels by total handler time** — main-side cost, with call counts. A
  high _count_ is a different bug from a high _per-call_ time.
- **Disk / store counters** — `store:thread-prefetch` reports calls, milliseconds
  and **bytes**; bytes is what distinguishes "many threads" from "few enormous
  threads".
- **Renderer-observed latency** — the `gap` column, as above.
