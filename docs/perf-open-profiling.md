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

## Measured result (2026-08-19, this profile)

Method: `~/.copse` cloned with `cp -Rc` (APFS copy-on-write — near-instant, near-zero
space, and byte-identical to the real profile), `COPSE_DIR` pointed at the clone so
the live app kept running untouched. Cold opens via `scripts/perf-open.mts`;
switches driven as real sidebar clicks via `scripts/perf-switch.mts`.

### Cold open

| | streaming-markdown (17 threads) | Copse (363 threads) |
| --- | --- | --- |
| `renderer:boot` (end to end) | **637 ms** | **7,695 – 9,471 ms** |
| `renderer:restore-project` | 483 ms | 7,586 – 9,358 ms |
| `threads:loadProject` (renderer-observed) | 431 ms | 6,950 – 8,638 ms |
| `store:read-project-threads` (main-side) | 394 ms | 6,451 – 8,021 ms |
| `store:thread-prefetch` | 17 calls, 4.9 MB | 363 calls, **210.8 MB** |
| `index:build` | 77 ms (224 paths) | 122 – 147 ms (2,981 paths) |

### Switch (real clicks)

| Click | `switch:activate` | `workspace-set` | `load-threads` | `apply-state` |
| --- | --- | --- | --- | --- |
| → Copse | **8,991 ms** | 60 ms | 8,480 ms | 451 ms |
| → streaming-markdown | 468 ms | 106 ms | 309 ms | 52 ms |
| → Copse *again* | **7,924 ms** | 71 ms | 7,582 ms | 270 ms |

### Conclusions

1. **One cause, ~94–98 % of it.** `threads:loadProject` → `readProjectThreads`
   reads and folds *every* non-archived thread in full — meta, spine, and every
   referenced message and blob file — then structured-clones the result to the
   renderer. For this profile that is 363 threads, 210.8 MB, ~50,600 files.
2. **Cost is a function of chat history, not of the repository.** The 6.1 GB of
   `.claude/worktrees` is correctly gitignored and never listed; `index:build`
   costs ~130 ms for the whole Copse checkout. Workspace size is not the problem.
3. **Nothing is cached across a switch.** Returning to Copse costs the same as
   arriving (7,924 ms vs 8,991 ms). The sidebar thread cache deliberately
   compacts transcripts away, and `finishActivate` re-reads from disk every time.
   Note the file index *is* correctly reused on return (`fresh=false`) — threads
   are the outlier.
4. **The sidebar only ever needed metadata.** Titles and timestamps are what the
   rows render; the full transcript of all 363 threads is loaded to display one.
5. `storage:get` ran 9,150 times during boot for a total of 87 ms — the
   write-through cache is doing its job. Config is not implicated.
