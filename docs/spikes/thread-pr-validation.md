# Relationship spike: additional validation

> Draft spike: rework after sidebar/activity redesign #3386 lands. These checks
> improve the evidence for the spike; they do not remove its merge prerequisites.

Validated on Debian 13 with Node 24.19.0 and Electron 44.4.2 (Node 24.21.0,
Chromium 152). The complete gate and clean-main comparison used main
`343ad4399ea2e8e8eab3bcfdd3156f33000c827b`. Main subsequently advanced to
`94660a7f9e61863f0c0f49a1b5402debb355e5cf` with usage-ledger and bounded-oracle
changes. The branch was rebased again; focused units for those base changes and
the relationships, protocol comparison, typecheck, build and native Electron
were repeated. The repository's bounded base-change policy excludes another
full-suite rerun solely for this base advancement.
The available pnpm 11.19.0 used `--config.verify-deps-before-run=false`; the
repository pins pnpm 10.34.5. No remote e2e host was configured. Xvfb was downloaded
from the signed Debian trixie package repository and extracted under `/tmp`.

## Native Electron provenance and restart

`tests/e2e/pr-provenance.e2e.ts`: **3 passed** through the real renderer, agent
loop, tools, main-process IPC, SQLite and authoritative thread files.

- The chat's `git_commit` tool made an actual commit in an isolated local Git
  repository after approving the real permission dialog. Its full SHA matched
  the thread's persisted commit production record.
- `gh_pr_create` recorded PR creation through the existing mock GitHub backend.
  A separate chat referenced this PR and another PR without acquiring production.
- `gh_pr_view` ran the native tool against a CLI fixture at the executable
  boundary. Its response attributed the actual Git SHA to the producing chat and
  left an unrelated full SHA unknown. No GitHub PR was published by this test.
- PR-to-chat and chat-to-PR IPC queries returned both production and reference
  relationships. After restarting the Electron process with GitHub unavailable,
  the PR UI retained both groups and its offline guidance. Clicking the related
  chat displayed both referenced PRs in its own list, each marked Related.

Reviewed screenshots: `pr-native-provenance.png`,
`pr-native-provenance-offline-restart.png`, and
`thread-native-multiple-prs-offline.png` under `tests/e2e/screenshots/`.
The online fixture has no GitHub detail for the newly created PR; its local
relationships remain visible alongside “Pull request not found”.

Reproduce:

```bash
pnpm --config.verify-deps-before-run=false run build
pnpm --config.verify-deps-before-run=false run test:e2e --spec tests/e2e/pr-provenance.e2e.ts
```

Linux requires `xvfb-run` on PATH. The local run prepended
`/tmp/thread-pr-native-packages/root/usr/bin`. Native Electron and its matching
ChromeDriver both used Chromium 152; no driver build-check override was needed.
Log: `/tmp/thread-pr-native-e2e-final.log`.

## Navigation races

The new regressions delayed the selected PR's relationship response, then changed
the PR, changed the project, or disposed the pane. Before the fix, each stale
selection could continue and request its old GitHub details after the response.
`selectPr` now checks its request generation and disposal immediately after
awaiting relationships. All three regressions passed and verify that late rows
neither repaint the viewer nor start obsolete detail requests.

The focused PR-pane suite passed **10 tests**. Log:
`/tmp/thread-pr-race-final.log`. The existing browser relationship and offline
refresh specs passed **4 tests** after the rebase and race fix. Log:
`/tmp/thread-pr-extended-visual.log`.

## Unscanned legacy chats

The new reproducible native API profiler persists actual legacy transcript files
without cached `prRefs`, including chats with no PRs. Every tenth chat references
two PRs; the first PR lookup must discover all matches, including the last matching
chat. It asserts reverse relationships, absence of production claims, persisted
scan markers, and identical answers after reopening the index.

| Chats | Matches | Metadata opening | First complete PR lookup | Max loop delay during lookup | Warm median / p95 | Reopened lookup |
| ----- | ------- | ---------------- | ------------------------ | ---------------------------- | ----------------- | --------------- |
| 1,000 | 100     | 125.1 ms         | 1,542.6 ms               | 10.1 ms                      | 0.274 / 0.417 ms  | 0.766 ms        |
| 5,000 | 500     | 527.2 ms         | 8,541.6 ms               | 17.0 ms                      | 0.885 / 2.725 ms  | 1.421 ms        |

Approximately 1.2 KB of transcript text per matching chat. First scans require
reading every active unscanned transcript and persisting its result; SQLite does
not eliminate that one-time cost. A 1 ms timer continued ticking during scanning
(1,509 ticks at 1,000 chats; 7,397 at 5,000), but the selected relationship query
waits for completeness. The latency is large enough to warrant an explicit
loading state/progress or background preparation in the redesign.

These are local container measurements, with a warm OS cache. The larger suite
was finishing concurrently; they are not isolated production performance claims.
They exclude IPC, renderer responsiveness, network access and a full process
restart. Reopened means closing and reopening native database handles in one
process. The native e2e separately establishes actual process restart correctness.

A third native Electron test then created 1,000 offscreen chats through storage
IPC and verified that every chat remained unscanned before the lookup. Its first
complete PR query found all 100 references, including the last offscreen match,
in **1,634.1 ms**, with zero production claims. The renderer drew **99 frames**
during the scan; its largest frame gap was **16.7 ms**. The subsequent IPC lookup
took **1.0 ms** and returned the same count. This is a single sample in the test
environment, not a production frame-rate guarantee. Unlike the separate module
profiler, it includes native IPC and observes the actual Electron renderer.
Raw data: [thread-pr-native-legacy-benchmark.json](thread-pr-native-legacy-benchmark.json).

The native test was repeated after the final rebase: **1,894.2 ms** first lookup,
**2.2 ms** warm IPC lookup, **114 renderer frames**, maximum frame gap **16.8 ms**.
Both runs are preserved in the raw report. All three native tests passed again.

```bash
node scripts/prototypes/thread-pr-relations/profile-legacy.mts
```

Raw data: [thread-pr-legacy-benchmark.json](thread-pr-legacy-benchmark.json).
Log: `/tmp/thread-pr-legacy-profile.log`. The existing healthy-index benchmark
still establishes the SQLite restart benefit; this profile supplies the previously
missing legacy backfill cost. SQLite remains useful as a rebuildable projection,
with files authoritative. Migration/preparation UX remains necessary.

## Clean-main comparison

The spike's complete `pnpm run check` passed all static gates and finished the
unit tier with **12,937 passed, 15 failed, 9 cancelled, 22 skipped**. All failure
names match the previous spike run and appeared in the clean-main comparison
below. The full gate remains not green. Its Python preparation worker again
outlived the 180-second timeout and was SIGTERM'd after more than three minutes.
Log: `/tmp/thread-pr-extended-check-final.log`. After adding the renderer-frame
step to the native fixture, its syntax gate was repeated; native tests were
rerun and the fixture was formatted.

An untouched worktree at `343ad4399ea2e8e8eab3bcfdd3156f33000c827b` ran the complete
unit tier: **12,888 passed, 16 failed, 9 cancelled, 22 skipped**. All fifteen
failure names reported on the previous spike head appeared in the baseline's
failure output: process-group cleanup (SemIf, portable engines, ACP and semantic
index shutdown), home/workspace paths, worktree preparation, shell gate replay,
and Cargo availability. They are reproducible without the spike changes.

One additional failing test, plus a licence-suite setup error, came from the first
baseline dependency layout resolving third-party packages outside its worktree.
After copying the installed pnpm tree into the worktree and keeping its own
workspace-package links, the two affected licence files passed **52 tests, zero
failures** on the same untouched main source. No baseline product code changed.

The Python preparation worker outlived its configured 180-second timeout. Only
that worker was SIGTERM'd after more than six minutes, allowing the runner to
finish. The earlier spike run required the same intervention. This is a blocked
full-gate environment, not a green suite or a reason to waive required CI.

Logs: `/tmp/thread-pr-clean-main-unit.log` and
`/tmp/thread-pr-clean-main-licenses-final.log`. Baseline source remains under
`/workspace/agent-pane-baseline-3502`; workspace packages resolve to that worktree,
not the spike branch.

## Final base refresh

On main `94660a7f9e61863f0c0f49a1b5402debb355e5cf`, bounded revalidation passed:
**477 unit tests** covering oracle-refresh, usage-ledger, aggregate-usage,
thread-store, thread-pr-relations, fork-thread and PR-pane. Typecheck, build,
protocol comparison (v41 → v42), format and oracle invariants passed; the native
Electron spec passed **3 tests** again. Logs: `/tmp/thread-pr-base-refresh-unit.log`,
`/tmp/thread-pr-base-refresh-types.log`, `/tmp/thread-pr-base-refresh-build.log`,
`/tmp/thread-pr-base-refresh-protocol.log`, `/tmp/thread-pr-base-refresh-format.log`,
`/tmp/thread-pr-base-refresh-oracle.log` and `/tmp/thread-pr-base-refresh-native.log`.
The complete gate above remains evidence for the prior base; the known failures
were not waived or rerun as a full tier for this base advancement.

## Remaining scope

Real GitHub publication/authentication, macOS behavior, representative production
repositories, crash-during-write GUI scenarios, external-file invalidation/rebuild
UX, green required CI and independent review remain outstanding. Unit coverage
already exercises interrupted writes and missing/corrupt/incompatible/copied index
recovery. Revalidate and rework after #3386; keep the PR draft.
