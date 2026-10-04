# SQLite thread projection spike

> Draft spike: do not merge as-is. Rework the UI integration, IPC contract, and
> cache plumbing after the [sidebar/activity redesign (#3386)](https://github.com/copse-dev/agent-pane/pull/3386)
> lands, then rerun the performance measurements and native validation.

## Task brief

Build setup 2: existing per-thread files remain authoritative, with a persistent,
rebuildable SQLite index serving project metadata and PR/thread/commit relationships.
Conversation content continues to load from the existing files. No renderer or IPC
shape changes are needed.

Draft handoff: publish the spike as a draft PR, retain its evidence and known
validation gaps, and make the post-redesign rework a merge prerequisite.

Review follow-up acceptance: relationship queries must include legacy active
chats before their rows become visible, including when an existing projection is
reopened. Persist the scan result so warm queries do not reread transcripts;
exclude archived chats and retry failed scans. Forks must derive references only
from the copied message slice, without inheriting production evidence. A selected
PR must refresh local relationships on thread changes even without GitHub details.
Cover these cases with storage/fork/renderer regression tests and a focused visual
eval, then update the draft with current-head validation.

Acceptance criteria:

- Project metadata loads and both directions of PR relationships use the real index.
  Production, references, legacy links, archive filtering, repository scope, and exact
  commit evidence retain their existing meaning.
- Updates, appends, deletes, bulk replacement, and background backfill update the
  projection. A crash between a source write and projection update repairs pending
  rows on restart. Missing, incompatible, or corrupt indexes rebuild from files.
- Cache paths retain the store's symlink/path guards. A failed cache cannot make
  authoritative files disappear or serve stale ownership claims.
- Profile the integrated reader at 100, 1,000, and 10,000 threads against the file
  reader: initial build, healthy restart, warm reads, relationships, incremental
  updates, recovery, disk size, memory, and event-loop delay. Record limitations.
- Run focused storage/provenance tests, the bundled Electron SQLite runtime check,
  the build, and the full repository check. This change adds no visible DOM.

## Completion evidence

Implemented in `packages/thread-store/src/sqlite-thread-index.ts` and the native
thread-store API. Project opening uses SQLite, with the existing 16-project
metadata LRU above it. Relationships query SQL directly. There are no new
dependencies, API payload changes, or visible DOM changes.

Review fixes add a partial SQL index for active chats whose `prRefs` have never
been scanned. PR-to-chat queries complete those scans through the existing bounded
backfill queue before answering; chat-to-PR queries scan only the requested chat.
Metadata-only project opening remains lazy. Completed and empty scan results
persist, so healthy warm/restart relationship queries do not read transcripts.
Failed scans reject and remain retryable; unavailable metadata cannot cause an
endless retry loop. The queue is released during scanning and rechecked before
querying, including for new chats saved while a backfill is in flight.

Fork construction now records references from only its copied message slice,
excluding later/queued messages and source-only cached links. It still excludes
all native PR/commit production evidence. The PR pane refreshes local relationships
and retains its header even with missing or unauthenticated GitHub CLI.

Pending IDs are durable before source writes. Successful and failed queued
operations repair their changed rows; reopening repairs interrupted operations.
Projection update and pending-ID removal share a transaction. Rebuilds remain
unready until their transaction commits. Cache failures fall back to files and
invalidate the projection before a source write proceeds. Unsafe cache symlinks
abort writes rather than touching targets. Metadata decoding and rebuilds yield
between batches of 128. Connections close on LRU eviction and normal Electron quit.

## Measurements and decision

Reproduce with:

```sh
node scripts/prototypes/thread-pr-relations/profile-integrated.mts
```

The harness calls the real store APIs. The file baseline uses the same metadata
reader and the preceding map index. Each dataset has three refs and one recorded
commit per chat, 10% PR producers, and a nonempty spine. One initial run and three
fresh-process restarts are recorded per backend/size, with a warm OS page cache.
Opening here means metadata plus the first PR query; process launch/import,
Electron IPC, rendering, GitHub requests, and transcript hydration are excluded.
All benchmark fixtures already have `prRefs`. One-time legacy transcript backfill
is additional work on a first relationship query and is not included in these
restart figures.
Warm operations have five warmups and 50 samples (20 for native writes).
Warm map lookups are measured directly; SQLite lookups include the native queue
and path guards. The warm timings therefore do not isolate SQL execution alone.

| Chats  | Files restart median | SQLite restart median | Speedup | SQLite initial build + open |
| ------ | -------------------: | --------------------: | ------: | --------------------------: |
| 100    |              34.8 ms |                9.3 ms |    3.7× |                     40.5 ms |
| 1,000  |             172.9 ms |               27.6 ms |    6.3× |                    172.7 ms |
| 10,000 |           1,257.9 ms |              136.8 ms |    9.2× |                  1,584.3 ms |

At 10,000 chats:

- Native PR query median / p95: SQLite **0.236 / 0.435 ms** versus maps
  **0.049 / 0.098 ms**. Both are small; SQLite does not win warm relationship queries.
- Recovery of one interrupted row followed by a PR query: **1.44 ms**, without
  scanning all chats. Full missing-index rebuild: **1,466.6 ms**.
- Metadata reload after a native write: **97.8 ms** versus **1,118.2 ms** from files.
  Ordinary warm project switches retain the existing near-zero snapshot hit.
- Initial build's worst observed 1ms-timer delay: **23.4 ms**; the largest delay
  across healthy SQLite restarts: **11.3 ms** versus **121.5 ms** for files/maps.
  Timer delay includes scheduler noise and is not an end-to-end UI frame guarantee.
- Native metadata write median: **39.8 ms** versus **42.1 ms** for files. Both still
  read/check/rewrite the existing whole-project `catalog.jsonl`; SQLite has not
  removed that O(N) cost. The first SQLite write delayed the timer by 46.2 ms.
  Catalog maintenance is the next useful migration if write latency matters.
- After GC, heap: **25.6 MiB** SQLite versus **36.7 MiB** files/maps. RSS was similar:
  **234.7 versus 239.8 MiB**, after initial construction. This does not establish
  a lower peak process-memory budget.
- Active cache artifacts total **56.9 MiB**, including WAL and SHM after rebuild.
  Searchable relationship payloads are duplicated for direct lookup; WAL can
  retain rebuild-sized data while open. This is a measurable disk cost.

**Decision:** the broader metadata-and-relationships projection makes SQLite
worthwhile for large projects and restarts. Keep files authoritative and retain
the metadata LRU. The relationship-only map result remains valid: the benefit
comes from avoiding thousands of metadata opens and rebuilding maps on restart,
not from making already-warm PR queries faster.

Raw results: [thread-sqlite-index-benchmark.json](thread-sqlite-index-benchmark.json).
These are synthetic Linux container measurements on Node 24.19.0, not cold-disk or
real-user latency guarantees. Authenticated production-project and native GUI
profiling remain follow-up validation before treating this spike as release-ready.

## Correctness boundaries

One process must own source writes through the store API, as with the previous
in-memory caches. Hooks cover saves, patches, appends, audit spines, deletes,
bulk replacement, and background backfill. Manual edits and external processes
are not watched: stop the app and delete `.thread-index.sqlite` plus its `-wal`,
`-shm`, and `-journal` sidecars after an external restore/edit. A copied database
has a source-directory identity and rebuilds in its new project.

Crash tests cover process death; source-file power-loss durability remains the
existing file-store contract. Evidence is not invented for shell commits or legacy
PR mentions. Cache recovery cannot supply provenance never recorded in files.
Conversation bodies still load from files. Production versus reference semantics,
archive filtering, host/repository scope, and all contributors to an exact SHA
retain their previous behavior.

## Validation before the draft base update

- Final focused storage/provenance/package suite: 408 passed, two macOS-only skips,
  no failures.
  Includes 15 new projection tests covering real SIGKILL recovery, persistent reads
  without source-file opens, archive/unarchive, transcript presence, bulk replacement,
  interrupted deletes, failed writes/reads/rebuilds, project scope,
  missing/corrupt/incompatible/copied caches, symlink protection, and concurrent
  rebuilds across 20 projects with idle-handle eviction.
- Bundled Electron Node 24.21.0: persistent projection, native writes, reopened
  PR relationships, metadata load state, and file transcript smoke passed.
- Final build passed: `/tmp/thread-sqlite-build-final.log`.
- Full `pnpm --config.verify-deps-before-run=false run check`: all static gates
  passed (syntax, typing, type coverage, lint, format, site sync, dead code, oracle,
  exclusions). Unit results: **12,635 passed, 13 failed, 9 cancelled, 17 skipped**.
  One failure was this spike's subprocess import fixture, misread as a package
  self-dependency by the source inventory. The fixture was corrected; all 23
  recovery/package tests passed afterwards, followed by the final 408-test focused
  run. The complete unit suite was not repeated after that test-fixture correction.
  The other 12 failure names exactly match the earlier baseline log: process cleanup,
  unavailable home paths, sandbox fixtures missing `socat`, and missing Cargo.
  The Python preparation worker stayed hung beyond its 180-second timeout and only
  that identified worker was terminated so the suite could finish. The full gate
  remains **not green**.

Logs: `/tmp/thread-sqlite-focused-final.log`, `/tmp/thread-sqlite-profile.log`,
`/tmp/thread-sqlite-package-recovery-final.log`,
`/tmp/thread-sqlite-full-check-final.log`. Full reports:
`.tmp/test-run-8JvkyF/`. Bundled Electron smoke covered the actual storage module,
not a graphical Electron IPC run. This task made no additional DOM changes; the
preceding relationship UI spike's visual evidence remains unchanged.
The combined draft was updated onto current main before publication, including
a protocol bump from v41 to v42. Current-head validation is recorded in the PR;
the results above describe the preceding spike revision.
