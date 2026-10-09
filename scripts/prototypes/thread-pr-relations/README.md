# Thread / PR relationships database prototype

The current integrated files-plus-SQLite projection is implemented in the native
thread store. Profile it with
`node scripts/prototypes/thread-pr-relations/profile-integrated.mts`; see
[the current report](../../../docs/spikes/thread-sqlite-index.md) for measured
startup/recovery results and correctness limits.

The preceding file-backed fix and relationship-only comparison are recorded in
[the earlier spike](../../../docs/spikes/thread-pr-relations.md). Its
`benchmark.mts` and `sqlite-index.mts` cover the standalone relationship index;
their native API measurements no longer represent the preceding file-backed
implementation. The sections below describe the original independent prototype.

## Task brief

The PR pane currently picks one URL-referencing thread and labels it “producing.”
`indexThreadLinks` keeps the first reference for a PR; the remote-agent JSONL index
keeps the last link for a PR. Neither proves ownership or commit creation.

Base revision: `933730f706ed196ed496c4a0c07b34434227db27`.

Acceptance: one thread references multiple PRs; multiple threads reference one PR;
both directions preserve every link; a PR read model distinguishes recorded commit
creation from unknown attribution. PR creation and URL mentions cannot establish
commit creation. Persistence, replay, repository/project isolation, and force-push
replacement must preserve those distinctions.

Scope: standalone SQLite experiment with synthetic input and queries for both views
and the PR tool. No app migration, UI changes, or live ingestion. Risks: false
attribution and cross-project disclosure. Validate with focused unit tests and the
demo, then the repository check gate; no visual eval applies to this isolated model.

## Run

Requires the repository's Node 24 toolchain; uses built-in `node:sqlite` and existing
Zod, with no new dependency or backend service.

```sh
node scripts/prototypes/thread-pr-relations/demo.mts
pnpm test -- scripts/prototypes/thread-pr-relations/store.test.ts
```

`ThreadPrRelations` defaults to an in-memory database; pass a file path for a
persistent database. The tests reopen a temporary database to verify persistence.

## Model

| Table               | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `threads`           | Identity is `(project_id, thread_id)`; titles can change.                                         |
| `pull_requests`     | Identity is `(host/owner/repo, number)`; tracks commit snapshot time.                             |
| `thread_pr_links`   | Many-to-many evidence of references or PR creation; retains source IDs.                           |
| `pr_commits`        | Latest complete provider snapshot of PR commit membership.                                        |
| `commit_provenance` | Append-only successful commit-creation events: repository, full SHA, thread, run, event ID, time. |

There is no owner column. `created` describes a successful PR-create action, while
`contributed` is derived from exact commit provenance and current PR membership.
A thread can have multiple relationships to a PR. The PR and thread queries return
all relationships; multiple pieces of reference evidence do not duplicate display rows.

`getPr(pr, authorizedProjectId)` is the proposed shared payload for the PR pane and
PR tool: `relatedThreads`, `commitsObservedAt`, and per-commit `attribution` plus
`evidence`. `getThread(thread)` supplies PRs for a thread view. These queries are
project-scoped; production must derive that scope from trusted execution context.
An unrestricted cross-project view would require its own access checks.

`commits: null` means no complete snapshot has been observed; `[]` means an observed
empty snapshot. `attribution: unknown` means no evidence is available in this scope,
not that the commit was made outside Copse. Snapshot time is returned so callers
can assess freshness. Older or equal snapshots cannot overwrite newer membership.
Paginated provider results must be assembled completely before ingestion.

## Equivalent approach without a database

Keep the existing filesystem-native store as the source of truth. Persist typed
relationship evidence and commit-creation events beside each thread; either extend
the spine or use a dedicated append-only journal with an explicit durable write
contract. Existing `prRefs` remain a lightweight reference cache. Store complete PR
commit snapshots separately, with their observation times.

Fold those records into project-scoped maps:

- `(repository, PR number) -> all related thread IDs and relationship kinds`
- `(project, thread) -> all related PRs`
- `(repository, SHA) -> all commit-creation evidence`

Use the same `getPr` / `getThread` payloads as the SQLite prototype. The current
single-result `lookupThreadByPrUrl` would become a plural lookup. The renderer's
`Map<PR, Thread>` becomes `Map<PR, Thread[]>`; both the first-wins and last-wins
behavior must disappear. Do not derive commit provenance from cached URL refs.

Persist a versioned JSONL reverse index as a rebuildable cache, following the
existing catalog/index pattern. Record the source event first; only then update
the cache. If the app crashes between writes, recover by replaying the journal or
rebuilding the index. Atomic replacement protects each index file individually;
it does not make several files transactional. A process-local write queue does
not coordinate multiple processes, so that contract must be explicit.

| Concern                    | Files / JSONL + maps                                                                          | SQLite                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Many-to-many relationships | Fully supported by arrays/sets and plural queries.                                            | Fully supported by join tables and queries.                                                                  |
| Commit provenance accuracy | Depends on trusted exact commit events.                                                       | Depends on the same trusted exact commit events.                                                             |
| Fit with Copse today       | Extends the existing native thread store and export model.                                    | Adds a second storage format; index-only avoids migrating threads.                                           |
| Query cost                 | Fast with loaded indexes; rebuilding scans source records.                                    | Indexed lookups load matching rows without loading the full index.                                           |
| Consistency                | Implement validation, uniqueness, sequencing, replay, and stale-index recovery.               | Constraints and transactions enforce consistency inside one DB; filesystem/DB dual writes still need replay. |
| Concurrency                | Existing per-project queue handles one process; additional coordination for multiple writers. | SQLite serializes writes across connections; busy handling and worker placement still required.              |
| Inspection / export        | Human-readable, easy to include with thread directories.                                      | Requires SQL tooling or explicit export; schema migrations still required.                                   |
| Recovery                   | Rebuild cached maps from durable source events.                                               | Rebuild if it is an index; backup/recovery is required if it is the sole source of truth.                    |
| Incremental complexity     | Lowest initial integration cost; index maintenance grows with more joins.                     | More setup now; simpler relational queries as the relationship graph grows.                                  |

Recommendation: introduce the explicit evidence model and plural API first. Keep
thread files as the durable source of truth. Start with the existing file-based
index if measurements show it is adequate; use the SQLite spike to evaluate a
rebuildable relational index when query cost or consistency work justifies it.
Measure project switch time, PR lookup latency, incremental-update cost, memory,
and rebuild/recovery time on real thread counts before selecting a storage engine.
No performance comparison has been measured by this spike.

## Production integration to evaluate

1. Backfill `prRefs`, scraped URLs, attachments, and legacy remote-agent links as
   **references**, keeping source IDs. The current remote link can be heuristic;
   only a successful provider PR-create result should establish `created`.
2. Record commit provenance at a trusted successful commit-creation boundary with
   exact repository, SHA, thread, and run. Git author, branch name, a generic Copse
   trailer, model prose, push success, or a before/after HEAD change cannot prove
   that a thread created a commit, especially in a shared checkout. This prototype
   accepts synthetic evidence; it does not implement the trusted recorder.
3. Replace PR membership from complete provider responses. Keep historical commit
   evidence after force pushes; a rewritten SHA stays unknown unless a trusted
   event records the new object. Squash, rebase, and cherry-pick lineage need a
   separate explicit derivation model before transferring attribution.
4. Render “Related threads” in the PR view and “Related PRs” in the thread view,
   with referenced / created / contributed labels and links. Use the same payload
   in the PR tool to answer which exact commits have recorded thread provenance.

Production decisions still needed: whether this is a rebuildable relational index
over durable events or the source of truth, schema versioning/migrations, deletion
and retention, concurrency and worker placement (the spike uses synchronous SQLite),
and provider-stable repository IDs to survive renames/transfers. The identity
normalization here assumes GitHub-style case-insensitive host/owner/repo names.

## Completion evidence

Implemented and tested the SQLite spike; the no-database alternative above is a
design comparison, not a second implementation. No latency or scale benchmark was
run, and production ingestion/UI remain future work.

- `node scripts/prototypes/thread-pr-relations/demo.mts`: passed with synthetic
  many-to-many links and recorded/unknown commit attribution.
- `pnpm --config.verify-deps-before-run=false test -- scripts/prototypes/thread-pr-relations/store.test.ts`:
  **5 passed, 0 failed** on the final code.
- Oracle with the four prototype files explicitly selected: **HIGH**, one focused
  unit file, zero Electron specs. The checkout has no merge-base with `origin/main`,
  so the default oracle invocation cannot determine the change set.
- `pnpm --config.verify-deps-before-run=false run check`: all `check:local` static
  gates passed. The full unit run reported 12,608 passed, 12 failed, 10 cancelled,
  and 17 skipped. Existing tests outside this prototype failed, including process
  cleanup, sandbox fixtures missing `socat`, and a Cargo fixture without Cargo.
  The Python worktree-preparation worker remained stuck beyond its configured
  180-second timeout; the test runner and that worker were terminated. The full
  gate is therefore **not green**. Detailed local output: `/tmp/thread-pr-check.log`;
  retained test reports: `.tmp/test-run-8wtC1S/`.
- No independent review or visual evaluation: this is isolated data plumbing with
  no Electron DOM or app behavior change. Source remains uncommitted atop the
  base revision recorded in the task brief.

The `verify-deps-before-run` override avoids this environment's pnpm 11 implicit
install, which failed trying to create an unavailable home-directory store. All
checks used the already-installed repository dependencies; no lockfile changed.
