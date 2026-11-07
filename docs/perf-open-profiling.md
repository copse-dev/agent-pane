# Measuring how long it takes to open a project

Debug-branch instrumentation for the reported symptom: _opening Copse on a large
project (Copse itself) takes a long time; a small project opens fast; switching
back to the large one is slow again._

Everything here is inert unless `COPSE_PERF=1` is set.

## Why the existing diagnostics were not enough

`event-loop-watchdog` and `startup-budget` measure boot phases that end at
`boot-complete`, which is roughly "the window exists and handlers are
registered". The cost the user feels lands _after_ that, in three places at once:

- renderer IPC (`workspace:set`, `threads:load-project`, git and file-tree calls),
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

## Measuring time to first activity and first token

The same trace can drive a fixed real chat turn and break ACP latency into host
preflight, session startup, provider wait, renderer delivery, and first paint:

```bash
COPSE_PERF=1 COPSE_PERF_AUTOPILOT=1 \
  COPSE_PERF_OUT=/tmp/copse-ttft.ndjson pnpm start
node scripts/perf-report.mts /tmp/copse-ttft.ndjson
```

Read the `ttft:*` records between `autopilot:send` and the first renderer span:

- `composer-submit`, `renderer-dispatch`, `main-dispatch`, and
  `dispatch-preflight-complete` bracket renderer-side gates, IPC delivery, and
  trusted execution-context/history setup.
- `acp-turn-assembly`, `acp-mcp-config`, `acp-env-forward`,
  `acp-worktree-baseline`, and `acp-skills` identify host-side setup costs.
- `acp-session-acquire` reports whether the session was fresh; compare fresh and
  reused turns before attributing startup time to the model.
- `acp-prompt-start` to `acp-first-activity` is the external agent/provider wait.
- `main-first-activity` to `renderer-first-activity` isolates chunk delivery and
  store/controller work from provider latency.
- `autopilot:ttfa`, `autopilot:ttfr`, and `autopilot:ttft` distinguish any visible
  activity, reasoning, and answer text. A tool call can therefore satisfy TTFA
  without being mislabeled as a text token.
- `autopilot:first-activity-paint` and `autopilot:first-token-paint` measure the
  renderer delay from store delivery through the frame after the DOM update.

Every record contains phase names, durations, booleans, and chunk kinds only;
prompts, file contents, thread ids, and workspace paths are not recorded.

## Page load: what runs before `boot()`

Everything above starts the clock at `renderer:boot-start`. Before that line runs,
the window has already spent a few hundred milliseconds loading `index.html`, its
stylesheets and `app.js`, and that cost is a function of the eager bundle's size,
not of the profile. `scripts/perf-page-load.mts` measures it:

```bash
pnpm run build
node scripts/perf-page-load.mts --runs 3
# headless Linux, as root:
xvfb-run -a node scripts/perf-page-load.mts --runs 3 -- --no-sandbox --disable-gpu
```

Each run launches the built app against a fresh isolated profile with the mock
LLM, reads the document's navigation and paint timings in place over the DevTools
protocol (a reload would be warm: V8's code cache would hide the compile cost),
and pairs them with the `main:window-create` → `renderer:boot-start` interval
from the `COPSE_PERF` trace. Columns, all milliseconds from navigation start
unless noted:

| Column        | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `window→boot` | `main:window-create` → `renderer:boot-start`: the page load as felt       |
| `interactive` | `domInteractive`: HTML parsed; `app.js` still compiling off-thread        |
| `DCL`         | `domContentLoaded`: `app.js` evaluated. `DCL − interactive` ≈ bundle cost |
| `FCP`         | first contentful paint                                                    |
| `boot`        | the `renderer:boot` span, for reference                                   |

### Where the time went (2026-10-23, dev build, empty profile, Linux container)

A Chromium startup trace (`--trace-startup`) of the main-branch build put the
page's ~400 ms before `boot()` in three places, none of them network or disk:

| Phase                                         | ms   |
| --------------------------------------------- | ---- |
| `v8.parseOnBackground` of `app.js` (7.2 MB)   | ~162 |
| `v8.evaluateModule` of `app.js` (main thread) | ~77  |
| `TextResourceDecoder::Decode` of `app.js`     | ~30  |
| `ParseAuthorStyleSheet` (`app.css`, 466 KB)   | ~4   |
| `ParseHTML`                                   | ~5   |

So the bundle's byte count is the lever. An esbuild metafile attributed the
7.2 MB like this (unminified dev build):

| Input                                    | KB   | Needed before first paint?                    |
| ---------------------------------------- | ---- | --------------------------------------------- |
| `src/renderer/views`                     | 1973 | yes (the app)                                 |
| `zod`                                    | 753  | yes, via shared schemas evaluated at import   |
| `@xterm/xterm` + `addon-fit`             | 446  | no: Shells pane, first tab only               |
| `@novnc/novnc`                           | 393  | no: Desktop pane, first connect only          |
| `vscode-material-icons` name table       | 321  | no: file tree, hidden pane by default         |
| `@copse/streaming-markdown`              | 320  | yes                                           |
| `src/shared/plugin-catalog.generated.ts` | 319  | no: Settings → Plugins → Browse only          |
| tiptap + prosemirror                     | ~900 | yes (the composer)                            |
| `highlight.js`, `dompurify`              | 236  | "lazy" by `import()`, but inlined (see below) |

Two structural findings:

1. **Dynamic imports were not lazy.** The renderer was built with `outfile`, and
   without `splitting` esbuild inlines every `import()` into the bundle. The
   highlighter, DOMPurify and dialog modules commented as "code-split" were all
   parsed and evaluated eagerly.
2. **A top-level `await` gated the whole bundle.** noVNC 1.7 runs a WebCodecs
   H.264 decode probe (`VideoDecoder.isConfigSupported`, then a real keyframe
   decode and `flush()`) behind a module-scope `await`. In a single-file ESM
   bundle that pauses evaluation of every module after it, `main.ts` included,
   until the probe settles. It measured 1.5–4 ms here with software decoding
   and no GPU; on real hardware it is a round trip to the GPU process.

### What changed

- `scripts/build.mts` and `scripts/dev.mts` build the renderer with
  `splitting: true` into `dist/renderer/` with hashed chunks under `chunks/`, so
  `import()` is real. The entry is still `app.js`; `index.html` is unchanged.
- `terminals-pane.ts` imports xterm on the first shell (`addTab` is now async;
  the first shell of a scope is created once per scope even when two listeners
  ask in the same tick).
- `vnc-pane.ts` imports noVNC on the first connect, which also moves its
  top-level `await` into a chunk nothing waits on at startup.

`app.js` went from 7.23 MB to 5.77 MB (dev build; −20 %). The eager graph also
pulls one 308 KB shared chunk (streaming-markdown and renderer helpers shared
with the lazy dialogs), so the eager JS total is 6.08 MB, −16 %.

Measured interleaved (main, branch, main, branch, …) so machine drift hits both
sides alike; the main build was a copy of `dist/` passed via `--dist`:

| Round  | `window→boot` main → branch | `DCL` main → branch | `FCP` main → branch |
| ------ | --------------------------- | ------------------- | ------------------- |
| 1      | 458 → 432                   | 407 → 382           | 500 → 476           |
| 2      | 463 → 412                   | 410 → 367           | 520 → 468           |
| 3      | 526 → 516                   | 463 → 454           | 568 → 564           |
| 4      | 450 → 421                   | 386 → 371           | 480 → 472           |
| median | 461 → 427                   | 409 → 377           | 510 → 474           |

The branch is faster in every pair, by 10–51 ms on `window→boot` (median −34 ms,
about 7 % of the page load on this machine). Boot itself (`renderer:boot`) is
unchanged. The absolute numbers are from a container with no GPU; the share of
the load spent compiling and evaluating `app.js` is what carries over.

### Measured and not taken

Release builds minify syntax only. Adding `minifyWhitespace` cut the release
`app.js` from 5.49 MB to 4.34 MB, but three runs each measured `window→boot`
medians of 448 vs 427 ms with overlapping ranges (391–462 vs 418–473), so it is
not in this change. Full `minify` would reach 3.33 MB at the cost of readable
renderer stack traces in builds that ship no source maps.

### Still eager, worth a follow-up

- `plugin-catalog.generated.ts` (319 KB) is only read by Settings → Plugins →
  Browse and could load on first open now that `import()` splits.
- `vscode-material-icons` (321 KB) is a synchronous name table behind the file
  tree's icon URLs; the tree is in a hidden pane at boot.
- `zod` (753 KB) is evaluated at import by shared schemas; `zod/mini` or
  deferring schema construction would be a larger change.

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

|                                            | streaming-markdown (17 threads) | Copse (363 threads)        |
| ------------------------------------------ | ------------------------------- | -------------------------- |
| `renderer:boot` (end to end)               | **637 ms**                      | **7,695 – 9,471 ms**       |
| `renderer:restore-project`                 | 483 ms                          | 7,586 – 9,358 ms           |
| `threads:load-project` (renderer-observed) | 431 ms                          | 6,950 – 8,638 ms           |
| `store:read-project-threads` (main-side)   | 394 ms                          | 6,451 – 8,021 ms           |
| `store:thread-prefetch`                    | 17 calls, 4.9 MB                | 363 calls, **210.8 MB**    |
| `index:build`                              | 77 ms (224 paths)               | 122 – 147 ms (2,981 paths) |

### Switch (real clicks)

| Click                | `switch:activate` | `workspace-set` | `load-threads` | `apply-state` |
| -------------------- | ----------------- | --------------- | -------------- | ------------- |
| → Copse              | **8,991 ms**      | 60 ms           | 8,480 ms       | 451 ms        |
| → streaming-markdown | 468 ms            | 106 ms          | 309 ms         | 52 ms         |
| → Copse _again_      | **7,924 ms**      | 71 ms           | 7,582 ms       | 270 ms        |

### Conclusions

1. **One cause, ~94–98 % of it.** `threads:load-project` → `readProjectThreads`
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

## Lazy thread loading (shipped path)

`threads:load-project` returns metadata only — `meta.json` plus a `stat` of the
spine — and a thread's transcript is read when that thread is opened
(`threads:load-messages`). There is no flag: this is the only path.

### The trap this had to avoid

`isBlankThread` is `messages.length === 0 && status === 'idle'`,
`pruneBlankThreads` drops blanks from the store, and the autosave reconciler
emits `threads:delete` for anything that left. A naive metadata-only load makes
all 363 idle threads look blank, so it would have **deleted the entire chat
history from disk** on the first launch. Hence `Thread.messagesLoaded`: `false`
means "unknown", which `isBlankThread` refuses to treat as blank. The spine is
`stat`ed (not read) so a genuinely empty thread is still distinguishable and
blank pruning keeps working for new threads.
`src/shared/store/lazy-thread-loading.test.ts` is the tripwire for that chain.

### Two readers, deliberately not one

`loadProjectThreads` (whole threads) and `loadProjectThreadMetas` (metadata) are
separate functions. Four main-process callers — release smoke, the automation
scheduler, cursor-agent discovery, whole-history search — genuinely want the
messages, and a load that quietly stopped returning them would break each in a
way no type checks: `messages` would simply be empty. The first cut of this
change did exactly that; the thread-store tests caught it.

### Keeping the sidebar honest

- **PR chips** come from links in message text, which a metadata-only load never
  reads. `prRefs` is cached on thread metadata and merged in as each message is
  appended. For older threads, sidebar rows request backfill only as they enter
  the visible viewport, in batches of at most ten; later pages wait until the
  user reveals them. Backfill batches share a global queue with at most two
  transcript reads at once. Results with links arrive over `threads:pr-refs` so chips
  appear without a relaunch. `sidebarPrRefs` still prefers a transcript that is
  in memory — a streaming thread must re-scrape, since `appendToken` mutates
  content in place.
- **Background writes** (automation triggers, queue resume after restart) call
  `ensureThreadMessages` before dispatch, so a run never appends onto a
  transcript that was never read. The agent's own LLM context is unaffected
  either way: `agent:run` passes ids, and main reads history from
  `agent-history.json`.
- **Residency** is bounded at 8 transcripts per project, pinning the active
  thread, anything running, and anything with a queue. Without it a long session
  would re-accumulate exactly the heap the eager load used to allocate up front.

### Possible future step: load from the catalog

The metadata load still reads 369 `meta.json` files (~270–310 ms). The existing
per-project `catalog.jsonl` would make that ~5 ms, but it carries only id, title,
timestamps and a digest — not `status`, `usage`, `worktree`, `todos` or
`pendingMessages`, which the sidebar and the queue both need. Extending the
catalog to cover them is a real option if this ever becomes the bottleneck; at
~300 ms it is not one today.

## Measured A/B (flag build, retained for the record)

`threads:load-project` returns metadata only — `meta.json` plus a `stat` of the
spine — and the active thread's transcript is fetched on demand via a new
`threads:load-messages`. One flag on one build, so the A/B is honest: with it off,
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

|                                  | baseline            | lazy                       |           |
| -------------------------------- | ------------------- | -------------------------- | --------- |
| `renderer:boot` (end to end)     | 8,393 / 7,511 ms    | **430 / 428 ms**           | **~18×**  |
| `renderer:restore-project`       | 8,278 / 7,408 ms    | 325 / 322 ms               |           |
| `threads:load-project`           | 7,547 / 6,772 ms    | 211 / 279 ms               |           |
| main-side read                   | 6,960 / 6,254 ms    | 119 / 226 ms               |           |
| bytes read                       | 363 calls, 210.8 MB | **1 call, 1.6 MB**         | **~130×** |
| `thread:hydrate` (active thread) | —                   | 298 / 158 ms (85 messages) |           |

Sidebar completeness is unchanged: still 363 rows.

### Switch — real clicks, small ⇄ Copse

| Click                | baseline `switch:activate` | lazy `switch:activate` |
| -------------------- | -------------------------- | ---------------------- |
| → Copse              | 7,918 ms                   | **225 ms**             |
| → streaming-markdown | 378 ms                     | 137 ms                 |
| → Copse again        | 7,653 ms                   | **162 ms**             |

~40× on the switch, with the visible thread's transcript arriving ~170–200 ms
later, after the pane is already interactive.

### What this prototype does NOT yet handle

Measured improvement is real; production readiness is not claimed. Known gaps,
from reading the code rather than from observation:

1. **Sidebar PR chips.** `sidebarPrRefs` scrapes PR links out of message text for
   threads in the _active_ project (compacted entries carry a pre-scraped
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

### Final numbers, with the production path

Re-measured after the PR-ref backfill, hydration-before-dispatch and eviction
landed — i.e. with all the extra background work in play:

|                                | baseline | shipped path |
| ------------------------------ | -------- | ------------ |
| `renderer:boot`, backfill pass | 8,393 ms | **655 ms**   |
| `renderer:boot`, steady state  | 7,511 ms | **491 ms**   |
| `threads:load-project`         | 7,547 ms | 369–519 ms   |
| active-thread hydrate          | —        | 203–298 ms   |

The backfill read 334 threads / 186 MB in the background during that first run
without pushing the open above 655 ms, and it is resumable — run 1 was killed
mid-pass and run 2 picked up the remaining 31 threads.

### Still open

- **Visual eval.** AGENTS.md requires one for user-visible changes: the sidebar
  with unhydrated threads (PR chips arriving via backfill) and the conversation
  pane during hydration. Not yet written.
- **Aged-profile boot fixture** (#994). Every cost here scales with profile size
  and CI only ever boots a pristine profile, so this regression is invisible to
  CI by construction. Without the fixture, nothing stops eager loading returning.
