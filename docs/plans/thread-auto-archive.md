# Finished-thread archival (#3330)

Task brief and completion evidence, 20 October 2026.
Base: `00a1ba24bf16eb8edca276b4b733369586895c16` (`origin/main`).
Reference: closed, unmerged prototype #3373. The purple merged-PR icon shipped in #3371 and is outside this change.

## Agreed behavior and acceptance criteria

- Auto-archive defaults to three days of inactivity. Users can disable it or choose a longer delay in global Settings.
- Only deterministically finished work archives automatically: an isolated clean checkout, every linked PR merged, and no commits beyond a verified merged PR head. Squash merges qualify even after source-branch deletion and pruning. Actual merge timestamps determine the delay; PR update timestamps do not.
- Shared checkouts, unknown Git/PR facts, open PRs, and unlanded work require a return-to-thread review with Archive and Keep active actions. Keep restarts the inactivity period. Disabling auto-archive disables these prompts too.
- Active agents, terminals/background jobs, unread completions, drafts, pending messages/diffs, dirty files, and active side chats prevent automatic archive. Only ignored dependency/scratch directories are disposable; their presence alone never establishes completion. Parent review archival requires its side chats to be archived first.
- Recheck metadata, live activity, whether the user has opened the thread, and checkout state before the serialized write. Readiness inspection never archives the thread being opened.
- Archival preserves the conversation and checkout. The Archived filter exposes archived threads and Restore; the notification offers Undo. Restore refreshes inactivity time and opens the preserved conversation. The instruction to finish the remaining gaps adopts this proposed discovery flow.

## Implementation and risk

Adds GitHub mergedAt/headRefOid evidence, guarded metadata-only archival, serialized readiness checks, global Settings, the return-to-thread review, Archived filtering/title search, Restore, and Undo. Discovery reads stored metadata without GitHub calls. Renderer loads overtaken by archive/restore are retried. Review state refreshes when activity or settings change.

The real Electron restart test exposed a restore/autosave interaction: restored metadata was mistaken for a new thread and could recreate its unloaded transcript. Restore now registers the existing metadata before notifying autosave, without resetting other threads' pending metadata edits. A regression test exercises autosave and hydration together.

Risk: medium. Default-on background writes to persisted metadata and new IPC/settings surfaces require full validation; this is not eligible for the low-risk fast path. The service fails closed on incomplete evidence and never deletes checkouts. The settings update extends an input enum and shares the unreleased protocol v63 bump (latest release v0.1.0-beta.15 uses v61).

## Validation evidence

Commands used Node 24.20.0 and pnpm 10.34.5 through `fnm exec --using=24.20.0 corepack pnpm`. Frozen-lockfile installation and `prepare:native` completed; Electron is 44.7.0. Copse blocked rebase because conflicts can detach this isolated checkout, so the supported fast-forward merge refreshed the base before PR creation. Backup stashes are retained.

- `pnpm run gen:api-protocol`, `pnpm run gen:api-protocol --check`, and `pnpm run gen:api-protocol --compare-ref origin/main --released-ref v0.1.0-beta.15`: passed. Log: `.tmp-auto-archive-protocol-base-oct20.log`.
- `pnpm test -- thread-auto-archive thread-archive archived-threads toast github-api-backend`: 71 passed before the final base refresh. Includes real Git/store coverage for pushed → squash-merged → deleted/pruned branches, merge timestamps, busy/dirty/pending-diff guards, races, and restore. Log: `.tmp-auto-archive-focused-oct20.log`.
- `pnpm test -- thread-archive thread-hydration persistence`: 69 passed after the restore fix, including the autosave/hydration regression. Log: `.tmp-auto-archive-restore-regression-fixed-oct20.log`.
- `pnpm run build`: passed after the restore fix. Log: `.tmp-auto-archive-build-restore-oct20.log`.
- `pnpm run test:e2e --spec tests/e2e/thread-auto-archive.e2e.ts`: all three cases passed after the restore fix. The real IPC path covers Archive → Undo, Archive → app restart → Archived filter → Restore → preserved transcript, and default/longer/disabled settings persistence. Log: `.tmp-auto-archive-e2e-restore-oct20.log`.
- `pnpm run oracle -- --explain`: broad coverage; full tiers required. Log: `.tmp-auto-archive-oracle-oct20.log`. No remote e2e host was configured (`.tmp-auto-archive-remote-oct20.log`); the focused capture used local Electron.
- `pnpm run check`: static gates passed; the completed unit run reported 15,250 tests, 15,228 passed, 18 failed, four skipped. Log: `.tmp-auto-archive-check-final-oct20.log`; runner completion/status: `.tmp/test-run-KZSDAZ/run-meta.json`. This run preceded the final restore fix. Subsequent full-check and `check:local` requests both timed out before producing logs. Final static revalidation after the restore fix remains blocked; the successful regression, build, and Electron runs above include that fix.

All five local macOS captures were inspected: `tests/e2e/screenshots/thread-auto-archive-review.png`, `thread-archive-undo.png`, `thread-archive-discovery.png`, `thread-archive-restored.png`, and `settings-auto-archive.png`. The review actions, Undo, archive discovery/Restore, preserved conversation, and delay control are readable and usable. Local captures are evidence, not committed Linux references. These tests use seeded conversations and real main-process IPC; they do not claim a real-model evaluation or a three-day wall-clock scheduler soak.

## Remaining work

Keep the PR draft until required CI and screenshot review resolve the remaining gates. The completed full-suite failures concern review preparation, Bash empty-array handling, six screenshot `/var` safety cases, the small-gate empty-diff fixture, nested-worktree Git signing, Python/pip availability, certificate verification, four SSH socket-length cases, and Cargo availability. They have not been established as baseline failures. Full oracle-selected e2e coverage remains for CI; local focused visual coverage is complete. Do not close #3330 until the agreed behavior ships and is verified.
