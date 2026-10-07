# Thread / PR relationship fix spike

Original file-index spike base: `933730f706ed196ed496c4a0c07b34434227db27`.

This report records the first, file-index stage. The subsequent integrated SQLite
implementation and profiling are documented in [thread-sqlite-index.md](thread-sqlite-index.md).
The combined draft must be reworked after the sidebar/activity redesign (#3386)
lands; it is not ready to merge.

Acceptance: preserve every thread/PR relationship in both directions; distinguish
recorded PR creation from mentions and legacy agent links; show producing and
related threads together with working navigation; expose exact recorded commit
provenance in `gh_pr_view`; preserve native evidence across stale renderer saves,
reload, archive/delete, and forks. Benchmark cold build, warm lookup, incremental
updates, disk recovery, and memory against SQLite at 100, 1,000, and 10,000 threads.

Scope: file-based app spike and a controlled cache/index benchmark. Thread files
remain the source of truth. No new database dependency or app migration. Risk:
false attribution, stale caches, cross-project identity, and visible regressions.
Validation: focused store/index/tool tests, focused WebdriverIO visual evidence,
static gates, and the full unit gate (record environmental failures separately).

## Audit

| Path                                  | Current evidence                                     | Decision                                                                    |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Message URL scrape / `prRefs`         | Mention or known reference, without production proof | Related reference only; retain all threads.                                 |
| Local tool / composer PR creation     | Structured backend result with URL and number        | Persist production only for successful non-noop creation.                   |
| Remote-agent text attachment          | Repo-filtered last URL mention                       | Agent-linked only; cannot establish production.                             |
| Imported Cursor provider snapshot     | A provider's agent/PR association                    | Agent-linked until explicit creation evidence is available.                 |
| `git_commit`                          | Successful requested commit and its output           | Resolve the reported object, never a later shared `HEAD`; record exact SHA. |
| Shell Git commands / generic trailers | No native commit-creation event                      | Unknown; no retroactive inference.                                          |
| Forked transcript                     | Copies text and tool results                         | References carry over; production never comes from replayed tool text.      |

The old renderer map kept the first mention, while the remote JSONL map kept the
last agent link. Neither is an ownership contract. One PR can have several
producing/contributing threads and many related threads.

## Implemented spike

The native store exposes plural queries in both directions, scoped to the trusted
active project. PR identity includes hostname, owner/repository and number. The PR
pane renders separate producing and related groups with one navigation button per
thread. The active thread's PR list includes cached references, live mentions,
legacy links and recorded creation, and labels every PR from the native projection.
Native creation appears even when the transcript does not contain its URL.

`prProductions` records a successful non-noop `pr-create` result with an event ID
and timestamp. `commitProductions` records `git-commit` with canonical repository,
full SHA, event ID and timestamp. They live in `meta.json`, survive stale renderer
saves, and are written by the existing project queue. Replaying a conflicting event
ID fails. Warm indexes replace only the changed thread; archive/delete removes it
from navigation, and unarchive rebuilds its relationships from retained metadata.
The reverse remote-agent index uses `agent-pr-index-v2.jsonl` so existing lossy
indexes are rebuilt. Its single-result compatibility API returns unknown when
several threads match.

The two new read channels are included in the generated protocol manifest. The
repository's whole-shape comparer classifies the optional thread-evidence fields
as breaking. The original spike bumped v35 to v36 and passed compatibility
comparison against its base. The combined draft now bumps current main from v41
to v42 to retain intervening protocol changes.

`gh_pr_view` reports producing and related threads and exact attribution for the
commits returned by GitHub. Missing local evidence is **unknown**. This is not a
complete-membership cache: it makes no completeness claim about GitHub's commit
list, and SHA changes after rebase/squash remain unknown unless recorded separately.
Quiet Git output, ambiguous commit summaries, a missing GitHub remote, shell-made
commits, and legacy history remain unknown. PR creation is not evidence of creating
the commits inside that PR. Copied fork transcripts do not copy production events.

Current scope is the active project's nonarchived threads. This does not provide
cross-project search, archived-thread navigation, cryptographic attestation, or
multi-process filesystem cache invalidation. Commit recording currently supports
GitHub.com remotes; enterprise URL identities remain separate in the relationship
model, while the existing PR list/fetch UI still assumes GitHub.com. Evidence writes
are best effort after successful external mutations: a write failure never changes
a successful Git/PR operation into failure. Such failures leave attribution unknown.
Atomic metadata replacement uses the existing store's durability contract; this
spike does not introduce an append-only provenance journal or new fsync guarantees.

## Performance and storage decision

**Keep files as the source of truth and the incremental in-memory index for this
fix. Do not add SQLite to the app yet.** Both indexes support the same many-to-many
model; changing storage does not improve provenance accuracy. SQLite is useful if
cold standalone queries or sustained large-project cache pressure become a product
requirement. It should then be a rebuildable projection, with a source generation
and stale-index recovery contract, rather than a migration of chat storage.

Run `node scripts/prototypes/thread-pr-relations/benchmark.mts`. Raw results:
[thread-pr-relations-benchmark.json](thread-pr-relations-benchmark.json). Measured
on Node 24.19.0, Linux, AMD EPYC 9V74. Synthetic workloads have three PR references
and one recorded commit per chat, PR creation for 10%, and about 30 chats per PR.
Each backend/size runs in a separate process; SQLite uses cached prepared statements,
WAL and transactions. Returned payloads are checked against the file index.

Budgets declared before measurement: warm lookup p95 <=1 ms, update p95 <=16 ms,
first lookup with cached metadata <=100 ms, and map heap at 10,000 chats <=20 MiB.
Warm samples include 50 warmups and 300 measurements; updates have 100 measurements;
restart recovery has seven samples without warmups. Recovery uses warm OS pages,
not an evicted-disk test. Lookup measurements exclude IPC, provider latency,
renderer paint and source-file writes. SQLite updates include its index transaction;
map updates are in-memory only, so these are index costs, not equivalent durable
source-write costs. Memory is incremental after metadata/native-index load, not
total application memory. RSS deltas depend on allocator reuse; near-zero or negative
SQLite heap deltas do not imply zero native memory use.

| Chats  | Backend | PR lookup p95 (ms) | Thread lookup p95 (ms) | Commit lookup p95 (ms) | Index update p95 (ms) | Restart recovery p95 (ms) | Additional heap (MiB) | Index disk (MiB) |
| ------ | ------- | ------------------ | ---------------------- | ---------------------- | --------------------- | ------------------------- | --------------------- | ---------------- |
| 100    | files   | 0.115              | 0.001                  | 0.002                  | 0.043                 | 4.95                      | 0.12                  | 0.06             |
| 100    | sqlite  | 0.773              | 0.058                  | 0.022                  | 0.115                 | 1.24                      | -0.00                 | 0.16             |
| 1,000  | files   | 0.075              | 0.002                  | 0.002                  | 0.031                 | 22.66                     | 1.00                  | 0.56             |
| 1,000  | sqlite  | 0.887              | 0.033                  | 0.014                  | 0.137                 | 0.98                      | -0.08                 | 1.27             |
| 10,000 | files   | 0.061              | 0.002                  | 0.002                  | 0.019                 | 194.89                    | 11.13                 | 5.65             |
| 10,000 | sqlite  | 0.665              | 0.041                  | 0.013                  | 0.109                 | 1.13                      | -0.08                 | 12.41            |

File recovery above evaluates an **optional** JSONL projection checkpoint. The app
currently rebuilds from metadata and does not persist this new checkpoint. SQLite
recovery reopens its saved index and queries the matching rows; it assumes an already
current, healthy index and excludes replay/rebuild if stale. Disk totals exclude WAL
sidecars and source metadata, and are not a full storage comparison.

Actual native metadata loads and first PR lookup after metadata load, in the file
workers (SQLite workers measure the same native source separately):

| Chats  | Metadata load (ms) | First cached-metadata lookup (ms) |
| ------ | ------------------ | --------------------------------- |
| 100    | 30.71              | 8.91                              |
| 1,000  | 170.76             | 19.01                             |
| 10,000 | 1280.34            | 129.58                            |

All warm lookup, update and heap budgets pass. The 10,000-chat first lookup exceeds
the 100 ms budget; the 1,000-chat case stays well within it. Native metadata loading
is about 1.28 seconds at 10,000 chats, and this app already needs metadata for its
sidebar, so a PR-only SQL cache would not remove that project-open cost. A map index
uses about 11 MiB extra at that size, while its warm PR queries are substantially
faster than this SQLite candidate. SQLite's strongest measured benefit is restarting
without rebuilding the graph (about 1 ms versus 195 ms for the JSONL candidate).

This supports the smaller file-based change for today's integration, with an explicit
startup limitation at 10,000 chats. If that scale is normal, prioritize warming or
building the index away from interactive rendering; choose SQLite when lazy indexed
reads without retaining all project relationships are required. No usage distribution
was available, so this is a controlled spike decision, not a claim about real user
profiles. The current 16-project LRU is a count limit, not a global memory budget.

## Validation

Focused regression set: 138 passed, zero failed, two macOS sandbox tests skipped on
Linux. Covers native persistence/cache updates, many-to-many queries, project/repo
isolation, stale saves, conflicting event replay, forks, archive/delete, remote-index
migration, creation versus noop, safe navigation labels, PR-tool output and an actual
approved Git commit with attribution trailers disabled.

An additional focused set passed 63 tests for PR pane filtering/loading/titles,
font-scale contracts, API manifest/bindings, workspace package boundaries and the
sidecar protocol-version handshake. Three remote-link service tests also passed.

Focused browser WebdriverIO: two tests passed. Inspected screenshots show one
producer plus two independently navigable related chats, two PRs on the reviewer
chat, and a mention-only PR with no recorded producer. Existing browser scenarios
also ran once: 46 passed; the initial relationship fixture failed because empty
inactive chats are pruned at startup. The fixture now uses real mention messages.
Only the three relationship screenshots are retained. Local Chromium 151 was used
with installed ChromeDriver 152 and its build check disabled; Electron IPC remains
covered by static typing and native service tests, not an Electron visual run.

Final `pnpm --config.verify-deps-before-run=false run check`: all static gates
passed (syntax, typecheck, type coverage, all lint shards, format, demo-site sync,
dead-code, oracle and exclusion checks). The full unit run finished with **12,621
passed, 12 failed, 9 cancelled, 17 skipped**. Remaining failures match baseline
areas: SemIf/ACP process cleanup, standalone-engine cleanup, unavailable home
paths, sandbox fixtures missing `socat`, and a Cargo fixture without Cargo. The
Python worktree-preparation worker remained stuck after its 180-second timeout;
only that worker was terminated at 211 seconds so the runner could finish. The
full gate is therefore **not green**. All change-related regressions are green.

Full log: `/tmp/pr-relations-full-check-final.log`; retained reports:
`.tmp/test-run-sCj24I/`. Focused logs: `/tmp/pr-relations-focused-final.log` and
`/tmp/pr-relations-final-regressions.log`. Build and final browser eval both passed:
`/tmp/pr-relations-build.log`, `/tmp/pr-relations-visual-final.log`. Protocol
comparison: `/tmp/pr-relations-protocol-compat.log` (v35 to v36, successful exit).
These checks preceded the draft base update. Current-head validation is recorded
in the draft PR; this earlier evidence is not a claim about its final source SHA.

Visual evidence:

- [Producer and all related chats](../../tests/e2e/screenshots/pr-producing-and-related-threads.png)
- [Reviewer chat with two PRs](../../tests/e2e/screenshots/thread-multiple-related-prs.png)
- [Mention-only PR with unknown producer](../../tests/e2e/screenshots/pr-mention-without-producer.png)
