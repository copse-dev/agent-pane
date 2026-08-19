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

|                                           | streaming-markdown (17 threads) | Copse (363 threads)        |
| ----------------------------------------- | ------------------------------- | -------------------------- |
| `renderer:boot` (end to end)              | **637 ms**                      | **7,695 – 9,471 ms**       |
| `renderer:restore-project`                | 483 ms                          | 7,586 – 9,358 ms           |
| `threads:loadProject` (renderer-observed) | 431 ms                          | 6,950 – 8,638 ms           |
| `store:read-project-threads` (main-side)  | 394 ms                          | 6,451 – 8,021 ms           |
| `store:thread-prefetch`                   | 17 calls, 4.9 MB                | 363 calls, **210.8 MB**    |
| `index:build`                             | 77 ms (224 paths)               | 122 – 147 ms (2,981 paths) |

### Switch (real clicks)

| Click                | `switch:activate` | `workspace-set` | `load-threads` | `apply-state` |
| -------------------- | ----------------- | --------------- | -------------- | ------------- |
| → Copse              | **8,991 ms**      | 60 ms           | 8,480 ms       | 451 ms        |
| → streaming-markdown | 468 ms            | 106 ms          | 309 ms         | 52 ms         |
| → Copse _again_      | **7,924 ms**      | 71 ms           | 7,582 ms       | 270 ms        |

### Conclusions

1. **One cause, ~94–98 % of it.** `threads:loadProject` → `readProjectThreads`
   reads and folds _every_ non-archived thread in full — meta, spine, and every
   referenced message and blob file — then structured-clones the result to the
   renderer. For this profile that is 363 threads, 210.8 MB, ~50,600 files.
2. **Cost is a function of chat history, not of the repository.** The 6.1 GB of
   `.claude/worktrees` is correctly gitignored and never listed; `index:build`
   costs ~130 ms for the whole Copse checkout. Workspace size is not the problem.
3. **Nothing is cached across a switch.** Returning to Copse costs the same as
   arriving (7,924 ms vs 8,991 ms). The sidebar thread cache deliberately
   compacts transcripts away, and `finishActivate` re-reads from disk every time.
   Note the file index _is_ correctly reused on return (`fresh=false`) — threads
   are the outlier.
4. **The sidebar only ever needed metadata.** Titles and timestamps are what the
   rows render; the full transcript of all 363 threads is loaded to display one.
5. `storage:get` ran 9,150 times during boot for a total of 87 ms — the
   write-through cache is doing its job. Config is not implicated.

## Prototype: lazy thread loading (`COPSE_LAZY_THREADS=1`)

`threads:loadProject` returns metadata only — `meta.json` plus a `stat` of the
spine — and the active thread's transcript is fetched on demand via a new
`threads:loadMessages`. One flag on one build, so the A/B is honest: with it off,
`messagesLoaded` stays `undefined`, the hydration listener never fires, and the
old path runs unchanged.

### The trap this had to avoid

`isBlankThread` is `messages.length === 0 && status === 'idle'`, and
`pruneBlankThreads` drops blanks from the store — after which the autosave
reconciler emits `threads:delete` for anything that left. A naive metadata-only
load makes all 363 idle threads look blank, so it would have **deleted the entire
chat history from disk** on the first launch. Hence `messagesLoaded`: `false`
means "unknown", which `isBlankThread` refuses to treat as blank. The spine is
`stat`ed (not read) purely so a genuinely empty thread can still be told apart
and blank-thread pruning keeps working for new threads.

### Cold open — Copse, 363 threads

| | baseline | lazy | |
| --- | --- | --- | --- |
| `renderer:boot` (end to end) | 8,393 / 7,511 ms | **430 / 428 ms** | **~18×** |
| `renderer:restore-project` | 8,278 / 7,408 ms | 325 / 322 ms | |
| `threads:loadProject` | 7,547 / 6,772 ms | 211 / 279 ms | |
| main-side read | 6,960 / 6,254 ms | 119 / 226 ms | |
| bytes read | 363 calls, 210.8 MB | **1 call, 1.6 MB** | **~130×** |
| `thread:hydrate` (active thread) | — | 298 / 158 ms (85 messages) | |

Sidebar completeness is unchanged: still 363 rows.

### Switch — real clicks, small ⇄ Copse

| Click | baseline `switch:activate` | lazy `switch:activate` |
| --- | --- | --- |
| → Copse | 7,918 ms | **225 ms** |
| → streaming-markdown | 378 ms | 137 ms |
| → Copse again | 7,653 ms | **162 ms** |

~40× on the switch, with the visible thread's transcript arriving ~170–200 ms
later, after the pane is already interactive.

### What this prototype does NOT yet handle

Measured improvement is real; production readiness is not claimed. Known gaps,
from reading the code rather than from observation:

1. **Sidebar PR chips.** `sidebarPrRefs` scrapes PR links out of message text for
   threads in the *active* project (compacted entries carry a pre-scraped
   `prRefs`; live ones do not). With transcripts unloaded, those chips would be
   missing until a thread is opened. The fix fits the existing design: persist
   `prRefs` into `catalog.jsonl` at write time, as `compactSidebarThread` already
   does in memory.
2. **Appending to an unhydrated thread.** A background/automation run that
   finalizes a message into a thread the user has never opened would append onto
   an empty in-memory `messages`. Needs hydrate-before-append, or append
   semantics that do not read the array.
3. **Visual evidence.** AGENTS.md requires a focused visual eval for user-visible
   changes; this branch has none. A real PR needs one covering the sidebar with
   unhydrated threads and the conversation pane during hydration.
