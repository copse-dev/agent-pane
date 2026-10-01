# Thread view options — prototype evidence

## PR-readiness evidence

Acceptance: option A is the default thread view, with aligned text, project filtering, sorting,
meaningful ages and a separate Has changes section. Projects remains the entry to project
management. Git inspection must find real uncommitted work without restoring retired worktrees.

Validated worktree base: `3612660294e1d25dc01329a46cc54bef40e61bd6` (`origin/main` after fetching
54 newer commits). Rebase backup `4a33d392c6f59ca8941814a098a43f4ecc82332e` is retained.
`corepack pnpm install --frozen-lockfile` and declared native preparation passed, exit 0:
`.tmp/thread-readiness-rebase-install.log`.

Verified changes:

- The renderer mounts the new thread view unconditionally; no feature flag is required.
- Section labels, titles, metadata and empty-state text share the 44px text column. Trailing
  labels use a 16px gutter. Dark/light DOM geometry and screenshots pass visual inspection.
- Search, project scope, Only changes and reversible sorting compose. A real commit removes
  the changed-work result after refresh. New thread clears the filters and retains its active
  identity through startup restoration; a terminal opens for that new thread.
- Existing project-manager tests use the visible Projects action. Whole-thread fork, signing
  approval, follow-up restoration and PR metadata assertions are preserved and pass.
- A conversation geometry test covers both the narrow default and wide reading-column caps.
  The offline pnpm preparation fixture uses the repository's pinned package-manager version.

Current-base validation:

- `corepack pnpm run check`: its unit phase reports **12,123 passed**, zero failures,
  cancellations or skips in `.tmp/thread-readiness-rebased-check.log`. The command was
  interrupted after that report, before its wrapper wrote an overall exit marker.
- All static gates subsequently passed. TypeScript, coverage and lint:
  `.tmp/thread-readiness-rebased-final-static.log`. After correcting formatting in two
  migrated specs, formatting and the remaining gates passed, exit 0:
  `.tmp/thread-readiness-rebased-remaining-static.log`. The final fixture formatting and
  e2e syntax checks passed, exit 0: `.tmp/thread-readiness-shard-fixes-static.log`.
- `corepack pnpm run build`: passed, exit 0, `.tmp/thread-readiness-rebased-build.log`.
- `corepack pnpm run oracle -- --explain`: broad, 341 Electron specs selected.
- `corepack pnpm run test:e2e --shard 1/4`: 84 passed / 1 failed, exit 1.
  `--shard 2/4`: 80 passed / 5 failed, exit 1.
  `--shard 3/4`: 85 passed, no failures. The third wrapper was interrupted; its complete
  WDIO report confirms all 85 finished in 10m20s. Logs:
  `.tmp/thread-readiness-rebased-e2e-{1,2,3}.log`.
- Focused rerun: **8 specs passed / 1 failed**, exit 1, in 1m45s:
  `.tmp/thread-readiness-ci-backstop-focused.log`. The corrected assertions, new sidebar,
  legacy PR backfill, terminal creation and prior WebDriver startup failure all passed:

  ```sh
  corepack pnpm run test:e2e \
    --spec tests/e2e/conversation-visual-hierarchy.e2e.ts \
    --spec tests/e2e/file-open-worker-error.e2e.ts \
    --spec tests/e2e/follow-up-suggestions.e2e.ts \
    --spec tests/e2e/git-signing-helper-approval.e2e.ts \
    --spec tests/e2e/message-fork-resend.e2e.ts \
    --spec tests/e2e/mobile-controls.e2e.ts \
    --spec tests/e2e/thread-sidebar.e2e.ts \
    --spec tests/e2e/visible-pr-backfill.e2e.ts \
    --spec tests/e2e/terminal-new-thread.e2e.ts
  ```

Across these runs, **257 distinct Electron specs passed**. The mobile-control spec still fails
during HTTPS setup with system curl's LibreSSL error, before its runtime assertions. A separate
fresh-certificate probe passed with both system curl and Node
(`.tmp/thread-mobile-tls-diagnostic-bundled.log`, exit 0); this does not resolve or establish
the cause of the real Electron failure. No TLS verification or assertion was disabled.

On October 1 the user explicitly requested CI as the backstop. The remaining **83 Electron
specs** are deferred to required PR CI. The mobile-control failure remains disclosed for CI
verification; it is not established as pre-existing. A ready same-repository PR runs precheck,
unit check, build and the oracle-selected Electron matrix. CI Passed and screenshot review
must complete before merge.

Visual evidence: inspected the final dark, light and Needs you / Working captures. The focused
spec saves four new `thread-sidebar-*.png` images. All 548 regenerated tracked references were
backed up under `.tmp/thread-readiness-visuals/rebased/` and restored to HEAD; original pre-rebase
captures are retained in its `pre-rebase/` subdirectory and the backup stash. Cleanup passed,
exit 0: `.tmp/thread-readiness-ci-backstop-cleanup.log`. CI owns existing Linux reference updates.

The following sections are historical implementation and alignment notes.

## Text alignment and PR-readiness audit

Base: `b47366762b804043b8653b219aef812db5d7a467`.
Acceptance: section labels, thread titles, metadata and empty-section text share one text
column; ages, project labels and section context share a right edge; sidebar chrome uses
consistent outer gutters. Verify actual DOM geometry and screenshots in dark and light themes.
Preserve option A, project filtering, the changes section and the shared outline sort icon.
Scope is alignment and readiness assessment; the existing IPC diff requires the full check.
Validation: focused sidebar tests, build, sidebar Electron spec, oracle and full check, plus an
audit of existing tests that assume the former project sidebar is the default entry point.

Initial alignment evidence:

- Section labels previously started 9px before row text. They now share the 44px text inset;
  outer gutters and trailing labels use 16px. File-count text now participates in the subtitle
  baseline, with its icon centered independently.
- `corepack pnpm test -- thread-sidebar thread-browser sidebar-thread thread-execution-context pane-resizer select-chevron-padding custom-properties display-headings`:
  53 passed. Log: `.tmp/thread-alignment-focused.log`.
- `corepack pnpm run build`: passed. Log: `.tmp/thread-alignment-build.log`.
- `node scripts/run-e2e.mts wdio.conf.ts --spec tests/e2e/thread-sidebar.e2e.ts --spec tests/e2e/activity-panel.e2e.ts --spec tests/e2e/terminal-new-thread.e2e.ts --spec tests/e2e/titlebar-workspace.e2e.ts`:
  five tests passed across sidebar, activity and terminal; titlebar workspace timed out.
  Exit 1, retained in `.tmp/thread-alignment-e2e.exit`; log: `.tmp/thread-alignment-e2e.log`.
  The titlebar spec saves its initial screenshot, then expects `.project-new-thread-btn`, which
  is absent from the new default view. Other project-sidebar specs still use the old entry path.
- Inspected refreshed dark, light and needs-you/working screenshots: section labels, row titles,
  metadata, empty-section text and trailing times now align. DOM geometry assertions pass in
  both themes. The final file-count baseline correction also passes:
  `node scripts/run-e2e.mts wdio.conf.ts --spec tests/e2e/thread-sidebar.e2e.ts` — three passed,
  exit 0. Log: `.tmp/thread-alignment-e2e-final.log`; status: `.tmp/thread-alignment-e2e-final.exit`.
  Inspected the final dark screenshot: file count, status and project text share a baseline.
  `git diff --check` passed. A delayed final build produced its normal completion log, but its
  foreground transport timed out; the subsequent successful Electron run verifies the built UI.
- `corepack pnpm run oracle -- --explain`: broad; all 336 Electron specs selected.
  Log: `.tmp/thread-alignment-oracle.log`. Full Electron validation is not complete.
- Full `corepack pnpm run check` was attempted in bounded background task
  `7512f804-42ac-41fb-bf13-a9fed1b0ec68`. It remained at TypeScript checking for approximately
  six minutes without advancing, then was stopped. Log: `.tmp/thread-alignment-check.log`.
  This is an incomplete gate, not a TypeScript failure. Host process diagnostics were denied
  (`/bin/ps: Operation not permitted`), so the cause is unconfirmed. No processes were left
  intentionally running. The background runner could not register completion notification for
  this external session, so task status was checked explicitly.
- No PR was created. Readiness remains blocked by the existing-entry-path regression and an
  unresolved full gate; the previous completed full check failed one Stage 0 preparation test.
  No base comparison establishes whether that unit failure is introduced by this branch.

## Accepted visual correction

Sort-arrow follow-up: replace the font-rendered filled arrow with the shared outline SVG,
preserve reversal and its accessible label, and verify both orientations and the refreshed screenshot.

Verified: `corepack pnpm test -- thread-sidebar` (8 passed), `corepack pnpm run build`
(passed), and `corepack pnpm run test:e2e -- --spec tests/e2e/thread-sidebar.e2e.ts`
(3 passed). Logs: `.tmp/thread-sort-icon-test.log`, `.tmp/thread-sort-icon-build.log`,
`.tmp/thread-sort-icon-e2e.log`. The spec checks SVG presence, absence of a text glyph,
both sort directions and actual ordering. Inspected the refreshed dark screenshot: the shared
outline arrow is thin, aligned, and no longer rendered as a filled font glyph.
This focused rerun does not clear the previously recorded full-gate failure.

Match option A rather than a three-column table squeezed into the old sidebar: a wider default
rail, display heading, compact attention summary, search, project and sort selectors, two-line
rows with a right-aligned meaningful age, and full-width selected fills. Keep real theme tokens.
Replace the uncommitted chip with a Has changes section after Needs you and Working; avoid
duplicating active threads, retain their file badges, and offer an Only changes action that finds
all dirty threads regardless of activity. Search and project scope must intersect that filter.
Validate default geometry, group order, section filtering, sort reversal, real Git refresh after
commit, new-thread filter clearing, and light/dark screenshots through the real app entry point.

### Option A implementation evidence

- Default width is now 354px; saved user-resized widths remain respected. The three-layout selector
  and table columns are replaced by option A's Activity list with project and sort dropdowns.
- `corepack pnpm test -- thread-sidebar thread-browser sidebar-thread pane-resizer select-chevron-padding custom-properties display-headings`:
  32 passed. Log: `.tmp/thread-view-a-focused-rerun.log`.
- `corepack pnpm run build`: passed. Log: `.tmp/thread-view-a-build.log`.
- `corepack pnpm run test:e2e -- --spec tests/e2e/thread-sidebar.e2e.ts --spec tests/e2e/terminal-new-thread.e2e.ts`:
  four tests passed. Log: `.tmp/thread-view-a-e2e.log`. Includes real repository changes,
  project/search intersections, sort reversal, new-thread reset, and terminal continuity.
- `corepack pnpm run test:e2e -- --spec tests/e2e/activity-panel.e2e.ts`: passed.
  Log: `.tmp/thread-view-a-activity-e2e.log`. A deterministic model fixture drives the real agent
  loop and approval IPC, holds a second run, and verifies both sidebar groups before an approval
  resolves. This is not a live-model quality evaluation.
- Inspected `thread-sidebar-activity-dark.png`, `thread-sidebar-inbox-light.png` (now the
  project-filtered Activity view), and `thread-sidebar-needs-you-working.png`: display heading,
  roomy rail, status summary, aligned row ages, secondary metadata, selected fill, and independent
  changes section match A's hierarchy. No horizontal overflow in the focused geometry check.
- Full `corepack pnpm run check`: static gates passed; 11,715 unit tests passed and one failed
  (`packages/review/src/stage0.test.ts`, trusted pnpm preparation against a read-only content
  store). Log: `.tmp/thread-view-a-check.log`; pnpm records exit 1. The foreground MCP response
  timed out while the command continued; the completed retained log is the evidence. No separate
  exit-status file was produced. This is the same failing test observed before the visual revision,
  not a proven base-branch failure. No unrelated reviewer changes were made.
- The focused visual workflow passes; the full Electron suite and migration of remaining tests
  that address the old project sidebar are not complete. This is not a complete PR-ready gate.

Base: `b47366762`. Scope: one standalone HTML exploration and a focused browser spec.
No Electron implementation, settings, permission behavior, or persistence was changed.

## Acceptance

- Compare Activity sidebar, Project groups, and a sortable Thread inbox in one canvas.
- Show waiting time, runtime, and update recency with realistic sample threads.
- Exercise selection, sorting, search/filtering, collapse, simulated decisions, and follow-up messages.
- Provide dark/light themes and responsive list-to-thread navigation.

## Results

- Runtime checked: Node v24.20.0; pnpm 10.34.5.
- The inline JavaScript passed a syntax parse.
- Copse browser interactions confirmed approval changes the summary from 3 waiting / 2 working
  to 2 waiting / 3 working, moves the thread, and exposes Pause run.
- Switching to Project groups retained the selected thread and its approved state.
- Clicking Updated twice in Thread inbox reversed chronological order; the oldest thread appeared first.
- Searching for reconnect reduced the list to one matching thread.
- Inspected browser screenshots of the dark Activity and Project views, and the light inbox.
  Rows, selected fills, time columns, and the approval result were readable.
- Canvas render succeeded using the saved document's contents. Path-based rendering failed:
  the canvas tool could not resolve the workspace-relative file, and rejects absolute paths.
  The editable source remains `prototypes/thread-view-options.html`.

## Follow-up: find uncommitted work

- Added an independent Uncommitted work toggle to all three layouts, row file counts,
  a sortable Uncommitted inbox column, and a selected-thread worktree breakdown.
- Includes staged, unstaged, and untracked files; finished threads remain eligible.
- Browser checks passed: six sample worktrees match; the clean approval thread is excluded;
  finished and untracked-only threads are included; title search reduces six matches to one;
  switching layouts preserves the filter; Needs you intersects to two matches; both sort
  directions work; a finished thread shows 1 staged + 3 unstaged files.
- Inspected the filtered dark sidebar and light inbox: the control, file counts, column,
  and selected-thread breakdown are readable.
- Extended the focused WebdriverIO spec with filtering, project intersection, sort directions,
  empty-state clearing, and screenshots. Its dependency blocker below remains unchanged, so
  the automated suite was not rerun. Project-filter intersection and narrow geometry remain
  unverified in the browser.
- This remains simulated worktree data in a standalone prototype, with no live Git integration.

## Automated check and gaps

Attempted:
`corepack pnpm run test:demo -- --spec tests/demo/thread-view-options.demo.ts`

Exit 1 during runner configuration: Cannot find module `zod`; this checkout has no local
`node_modules`. No WebdriverIO assertions ran and no reference PNGs were written by that spec.
Log: `.tmp/thread-view-validation/browser.log`.

The spec covers the default entry state, approval/pause/resume, project/search/filter/collapse,
column sort directions, draft retention, themes, narrow navigation, question response, rejection,
and escaped follow-up content. After dependencies are available, run:
`corepack pnpm run test:demo --spec tests/demo/thread-view-options.demo.ts`.

Narrow layouts and the remaining spec interactions are implemented but not browser-verified.
Full repository checks were not run for this standalone prototype; no commit or PR was created.

## App implementation

Base: `b47366762`. The requested follow-up replaces the default project tree with a thread
sidebar: Activity, project groups, and a flat inbox; sortable title/update/change columns;
title/project/branch search; project and attention filters; and an independent uncommitted-work
filter. The existing project-management surface remains reachable through Projects.

Acceptance includes finding dirty threads in unopened projects, counting staged/unstaged/untracked
paths without double-counting a path, retaining real conversation navigation, and refreshing after
a commit. Unavailable and retired checkouts must not be reported as clean. Browsing must not restore
retired checkouts or change stored branch metadata.

Git inspection uses the existing owner-validated IPC with an explicit read-only inspection mode.
The sidebar loads metadata, bounds concurrent status requests to two, and refreshes from worktree
notifications. SSH status is currently unavailable in this view. Layout/filter choices are local to
the mounted sidebar; they are not persisted settings.

Validation performed during implementation:

- Node `v24.20.0`, Corepack pnpm `10.34.5`; locked dependency installation succeeded.
- `corepack pnpm test -- thread-sidebar thread-browser sidebar-thread thread-execution-context`:
  36 tests passed. Log: `.tmp/thread-view-focused.log`.
- `corepack pnpm run build`: passed. Log: `.tmp/thread-view-build.log`.
- `corepack pnpm run test:e2e -- --spec tests/e2e/thread-sidebar.e2e.ts`: all three tests passed
  against Electron and two temporary real Git repositories. This covers the normal app startup,
  an unopened project's Git state, thread navigation, combined filters/sorting, and a real commit.
  Log: `.tmp/thread-view-e2e.log`.
- Inspected `thread-sidebar-uncommitted-dark.png` and `thread-sidebar-inbox-light.png` under
  `tests/e2e/screenshots/`: controls, selection, and counts are readable without horizontal overflow.
  Follow-up changes allow two-line titles at the default sidebar width and clear filters when
  creating a thread; these require the final visual rerun.
- `corepack pnpm run oracle -- --explain`: broad, because the default app entry point and preload
  boundary changed. Log: `.tmp/thread-view-oracle.log`.
- Full `corepack pnpm run check` passed typecheck, type coverage and lint, then stopped at formatting
  of the earlier prototype HTML and demo spec. Log: `.tmp/thread-view-check.log`.

Final formatting, full checks, and the visual rerun remain pending. Later regression tests also
cover metadata-only rendering and a refresh arriving during an in-flight Git status request.
Final Copse command requests stalled before creating a task or log and returned a transport timeout
(`timed out awaiting tools/call after 300s`). A local CLI fallback could not even launch the runtime
probe: `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71). No unsandboxed CLI retry
was attempted. The final source changes therefore remain unverified by a completed final gate.
No full Electron suite, commit, or PR has been completed. Optional advisor review was rejected by
automatic approval review because its destination for conversation/repository context was unspecified.

### PR readiness follow-up

The delayed final check did eventually run. `.tmp/thread-view-check-final.log` records passing
TypeScript, type coverage, lint, formatting, dead-code and other static checks, followed by a
failing unit suite (11,531 passed; 80 failed). Many failures explicitly report denied socket binding
or nested sandbox execution, but not all failures have been classified. This is not a green gate.

Two task-related failures were identified: the new selects overrode shared chevron styling, and
the generated API manifest was stale after adding the optional Git inspection argument. The select
rule now preserves the shared background image and right padding. Protocol regeneration passed
(`corepack pnpm run gen:api-protocol`, `.tmp/thread-view-protocol.log`); the optional trailing
argument is additive and keeps protocol v31. The focused rerun passed all 60 tests:
`corepack pnpm test -- thread-sidebar thread-browser sidebar-thread thread-execution-context select-chevron-padding api-protocol`.
Log: `.tmp/thread-view-readiness-focused.log`.

Existing Electron tests also need review against the new default entry path. For example,
`tests/e2e/terminal-new-thread.e2e.ts` still clicks `.project-new-thread-btn`, whereas the new
sidebar uses the accessible `New thread` button and puts project controls behind Projects.
The earlier three-test visual pass does not establish compatibility with these existing flows.
Final visual evidence and a successful full gate remain required before marking this PR-ready.
