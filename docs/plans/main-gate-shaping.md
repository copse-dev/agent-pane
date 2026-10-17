# Main gate shaping: small main gate, complete release gate

Status: **Proposed**. Audit and design only; **no policy change**. Nothing here alters a
workflow, ruleset, required check, oracle selection rule or merge gate. Compiled 15 October 2026
against main `5cfc66e77`; the measurement window is CI runs created 24 September to 15 October 2026. This is item 2 of the
[recovery lessons and development throughput plan](https://github.com/copse-dev/agent-pane/pull/3770)
(`docs/plans/recovery-throughput.md` once that PR lands). Follow [AGENTS.md](../../AGENTS.md) and
the live repository rules until an explicit gate change lands as its own PR.

The question the recovery plan asks is whether entry to `main` can run the affected visual specs
plus a small, stable, cross-app smoke suite instead of the full Electron suite whenever the oracle
cannot thin, while the release gate stays complete and runs on an immutable candidate that is
then released exactly as tested. The answer here is in five parts: what runs today, why the
expensive `full` plan fires and how often, a smoke inventory and selection rule, what promotion
attestation is missing, and a shadow run that must produce evidence before any gate changes.

## 1. What runs today

Derived from [`ci.yml`](../../.github/workflows/ci.yml),
[`merge-queue-gates.yml`](../../.github/workflows/merge-queue-gates.yml),
[`promote-develop.yml`](../../.github/workflows/promote-develop.yml),
[`release-cut.yml`](../../.github/workflows/release-cut.yml),
[`release-mac.yml`](../../.github/workflows/release-mac.yml),
[`release-publish.yml`](../../.github/workflows/release-publish.yml), the repository rulesets as
read through the API on 15 October 2026, and
[`docs/testing-strategy.md`](../testing-strategy.md#where-each-tier-runs-main-and-release).
Line references are to the files at `5cfc66e77`.

Runner routing: every check-tier job runs on `ubuntu-latest` unless the `SELF_HOSTED_CHECKS`
variable opts it onto the fleet (`ci.yml` 94-121, 150, 812); e2e runs on `ubuntu-latest` unless
`SELF_HOSTED_E2E=copse-e2e` (1393-1427); merge groups, forks and the nightly schedule are pinned to
hosted. Every sampled run in the window reported `ubuntu-latest` for every job. The
model-backed `bench-agent-model`, `doctrine-eval-model`, `eval-tool-preference` and
`scratch-path-eval-model` jobs need `vars.LM_EVAL_RUNNER` and only run on the nightly schedule or
with their labels (1060-1226); they were skipped in every sampled run and are omitted below.

"Required" means named by a ruleset's `required_status_checks`. `Main protect` (ref `main`)
requires `CI Passed`, `Screenshot review` and `CLA`, allows squash merges only, and does **not**
require branches to be up to date (`strict_required_status_checks_policy: false`).
`Release protect` (ref `release`) requires `CI Passed` only and allows merge commits only.
Everything else below is executed but not required by a rule; it reaches the merge only through
the `ci-passed` aggregate (`ci.yml` 2163-2310), whose logic is part of the gate even though no
ruleset names the individual jobs.

| Event                                      | Jobs executed (shards)                                                                                                                                                                                                                                                                                                                  | Check context published                                | Required by ruleset                                                                                                                   | Sources                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| PR into `main`, draft                      | `precheck`, `screenshot-baselines`, `autoformat`, `check` (full unit suite plus coverage ratchet), `review-cell` when the reviewer cell changed. `build`, `e2e`, `bench`, `screenshot-artifacts` are skipped unless `ci-full` is set.                                                                                                   | `CI Passed`                                            | `CI Passed`, `Screenshot review`, `CLA` on the head; a draft cannot merge anyway                                                      | `ci.yml` 137-167, 639-661, 663-675, 805-870, 923-930, 1269-1276, 1364-1377 |
| PR into `main`, ready, plan `skip`         | As above plus `build` (dist artifact). Zero e2e shards are dispatched; `ci-passed` accepts the skip explicitly.                                                                                                                                                                                                                         | `CI Passed`                                            | same                                                                                                                                  | `ci.yml` 481-493, 570-574, 1365, 2299-2304                                 |
| PR into `main`, ready, plan `subset`       | As above plus `e2e` on `ceil(specs / 4)` shards, capped at 8, running only the listed specs; `screenshot-artifacts` after a green e2e. No `bench`.                                                                                                                                                                                      | `CI Passed`                                            | same                                                                                                                                  | `ci.yml` 575-599, 1354-1377, 1585-1610, 2024-2028                          |
| PR into `main`, ready, plan `full`         | As above with `e2e` on all 8 shards running the whole CI suite (401 specs at `5cfc66e77`), two attempts per shard, fail-fast on unless `ci-full`. `bench` only with `ci-full`.                                                                                                                                                          | `CI Passed`                                            | same                                                                                                                                  | `ci.yml` 601, 960-972, 1447-1469, 1937-1960                                |
| PR into `main` from a fork                 | `precheck` only, hosted, read-only token (typecheck, lint, format, dead-code, API protocol, audit, oracle liveness). No unit, build or e2e.                                                                                                                                                                                             | `Fork CI Passed`                                       | `CI Passed` is never published, so the rule holds the merge                                                                           | `ci.yml` 123-128, 150, 2174-2193, 2249-2252                                |
| `merge_group` into `main`                  | Would run `precheck`, `check`, `review-cell`, `build`, oracle-planned `e2e` with a positive shard count required, all pinned to hosted, plus `Merge queue decisions`. **Never observed**: zero `merge_group` runs of `ci.yml` and zero runs of `merge-queue-gates.yml` exist.                                                           | `CI Passed`, re-reported `Screenshot review` and `CLA` | No ruleset has a `merge_queue` rule, so no queue exists                                                                               | `ci.yml` 41-44, 2262-2298; `merge-queue-gates.yml` 1-50                    |
| Promotion PR `promote/main` into `release` | `precheck` forces `mode=full` ("promotion gate"), `check`, `review-cell` when required, `build`, `bench`, `e2e` on 8 shards (whole suite), `screenshot-artifacts`. `autoformat` is excluded so no commit can be added to the pinned head.                                                                                               | `CI Passed`                                            | `CI Passed` only; auto-merge with a merge commit                                                                                      | `ci.yml` 494-503, 633-636, 665, 960-972; `promote-develop.yml` 59-174      |
| Push to `main` (a PR landed)               | `precheck`, `screenshot-baselines`, `check`, `build`, `review-cell` when required. `e2e` and `bench` are excluded for this event; `build` still produces a dist artifact nothing consumes.                                                                                                                                              | `Develop CI Passed`                                    | Not a gate (the context name is distinct so it cannot satisfy `release`)                                                              | `ci.yml` 963, 1366, 2163-2193                                              |
| Push to `release` (a promotion merged)     | `precheck` runs the **oracle against the previous `release` tip**; nothing forces `full` for a push. `check`, `review-cell`, `build`, `bench`, `e2e` on whatever the plan says, no `screenshot-artifacts`. Observed: 13 of 13 completed pushes in the window ran 8 full shards, because a promotion batch always trips a broad pattern. | `CI Passed`                                            | Consumed by `release-mac.yml` preflight (exact-SHA `CI Passed`) but not by a ruleset                                                  | `ci.yml` 453, 499-503, 515-525, 963, 1366; `release-mac.yml` 118-138       |
| Nightly `schedule` (06:17 UTC)             | `precheck` with `mode=full`, `review-cell` forced required, `check`, `build`, `bench`, `e2e` on 8 shards, hosted; the LM-eval jobs when a runner variable is set.                                                                                                                                                                       | `CI Passed` on the `main` tip                          | Not a gate; the safety net                                                                                                            | `ci.yml` 34-40, 210-215, 468-472, 1421                                     |
| Release tag `v*`                           | `ci.yml` declares `push: tags: ['v*']`, and a hand-pushed tag would plan `full` (no base SHA). **In practice no CI run happens at a tag**: `release-cut.yml` creates the tag with `GITHUB_TOKEN`, which raises no `push` event, and dispatches `release-mac.yml` directly.                                                              | none at the tag                                        | none                                                                                                                                  | `ci.yml` 10-12, 514-519; `release-cut.yml` 133-146                         |
| `Release (macOS)` for a tag                | `preflight` validates tag, version, ancestry from `release` and waits up to 90 minutes for a `CI Passed` check run on the exact commit; `verify-clean-release-build` (frozen lockfile, hosted); `build-test` on `macos-26` for arm64 and x64 (sign, notarize, staple, packaged smoke test); `assemble`.                                 | none; produces immutable artifacts                     | none; publication is manual through `release-publish.yml`, which re-verifies tag, ancestry, the source run's `head_sha` and checksums | `release-mac.yml` 31-138, 145-175, 353-362; `release-publish.yml` 53-137   |

Where the documentation and the workflows disagree:

- **Merge queue.** `docs/testing-strategy.md` 544-556 and
  [`ci-base-freshness.md`](ci-base-freshness.md) 86-90 and 238-244 say `main` uses GitHub's merge
  queue and that the queue supplies the base-advancement gate. The rulesets read on 15 October
  2026 contain no `merge_queue` rule, `ci.yml` has never run for a `merge_group` event, and
  `merge-queue-gates.yml` has never run. Today a PR merges on a `CI Passed` earned by its own
  head against whatever base it had, with `strict_required_status_checks_policy: false`; the
  base-freshness check stays advisory. The queue code paths in `ci.yml` 2262-2298 are untested
  in production. The recovery plan already flags this; the gate change proposed here must not
  assume a queue exists.
- **Push to `release` is not forced to `full`.** The table in `docs/testing-strategy.md` 568
  lists it as **full**. `ci.yml` 499-503 forces `full` only for `pull_request` and `merge_group`
  events whose base is `release`; a push plans with the oracle against `github.event.before`
  (453, 525). A promotion batch usually trips a broad pattern (lockfile, `package.json`), so the
  observed result is normally full, but that is an accident of batch content, not a rule. This
  matters because the `CI Passed` that `release-mac.yml` waits for is the push run's, not the
  promotion PR's (section 4).
- **Release tags do not run CI.** `docs/testing-strategy.md` 569 lists "release tags" under
  **full on GitHub-hosted runners**. The only way a tag is created in the documented flow is
  `release-cut.yml` 113, with `GITHUB_TOKEN`, which GitHub does not turn into a `push` event; the
  workflow's own comment at 133-138 relies on that. The `tags: ['v*']` trigger in `ci.yml` is
  live only for a tag pushed by hand.
- **Push to `main` is not quite "light".** `build` has no push-to-`main` exclusion (1269-1286),
  so every landed PR builds a dist artifact that no job downloads. This is roughly five hosted
  minutes per landing (observed on run 38662902006) and is a cleanup, not a gate question.
- **Runner language is stale.** `docs/testing-strategy.md` 283-285 still speaks of
  "self-hosted PR/push runners" as the way to avoid hosted e2e cost; routing has defaulted to
  hosted since the repository went public (`ci.yml` 94-121), and every sampled job ran there.
- **A stale ruleset remains.** `Default protect` targets the default branch minus `main` plus
  `refs/heads/develop`, with the strict policy on. It matches nothing today and should be
  retired separately so it cannot surprise a branch rename.

## 2. Why `full` fires

### Every path to `mode=full`

The `precheck` plan step (`ci.yml` 447-527) exits early in this order, before the oracle runs:

| Order | Condition                                                                                  | Result         | Source             |
| ----- | ------------------------------------------------------------------------------------------ | -------------- | ------------------ |
| 1     | `schedule` event                                                                           | `full`         | `ci.yml` 468-472   |
| 2     | PR body declares a `copse-screenshot-stack` whose tip is this PR and the PR is not a draft | `full`         | 411-436, 473-480   |
| 3     | Head commit touches only `tests/e2e/screenshots/manifest.json` or `README.md`              | `skip`         | 481-493            |
| 4     | `pull_request` or `merge_group` whose base is `release`                                    | `full`         | 494-503            |
| 5     | `update-screenshots` label                                                                 | `full`         | 504-508            |
| 6     | `ci-full` label (also enables `bench` and turns fail-fast off)                             | `full`         | 509-513, 969, 1467 |
| 7     | No base SHA: schedule, branch create, or a force-push whose `before` is unknown            | `full`         | 514-519            |
| 8     | Otherwise `node scripts/test-oracle.mts --plan --base "$BASE_SHA"`                         | oracle decides | 520-527            |

Inside the oracle ([`scripts/test-oracle.mts`](../../scripts/test-oracle.mts)):

| Condition                                                                                                                                                                                                                                                                                                                                      | Result   | Source              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- |
| `git merge-base HEAD <base>` is empty, so the change set is unknown (`baseUnknown`)                                                                                                                                                                                                                                                            | `full`   | 261-278, 753        |
| Any changed path matches `BROAD_PATTERNS` (wdio configs, `tests/e2e/{helpers,electron-shell,fixtures,scenarios}`, `tests/demo`, `package.json`, lockfile, `tsconfig*`, build scripts, `index.html`, renderer entry files, demo scenarios, shared stylesheets, `src/preload`, `src/shared/store`, `src/main/index.ts`, `src/main/ipc/index.ts`) | `full`   | 62-91, 752-753, 408 |
| Confidence `low`: a changed shipped source file under `src/` (`.ts`, `.mts`, `.tsx`, `.js`, `.mjs`, `.css`, `.html`) that no spec imports and whose text contains no spec's selector token                                                                                                                                                     | `full`   | 818-826, 408        |
| Selected runnable specs exceed half of the runnable suite                                                                                                                                                                                                                                                                                      | `full`   | 410                 |
| Nothing selected after removing `wdio.ci.conf.ts` exclusions                                                                                                                                                                                                                                                                                   | `skip`   | 409, 314            |
| Otherwise                                                                                                                                                                                                                                                                                                                                      | `subset` | 411-413             |

Two further facts shape the cost. A draft PR never dispatches the heavy tier, so a `full` plan on
a draft costs nothing until `ready_for_review` (1269-1276, 1364-1377). And `full` is deliberately
the fail-safe answer for the least-understood change: the LOW-confidence rule exists precisely
because a backend file with no DOM coupling may drive a flow no selector exposes (`ci.yml`
1356-1360). The design in section 3 keeps that asymmetry.

### How often each plan ran, and what it cost

Method. Workflow runs were listed through the Actions API for `ci.yml` created 24 September to
15 October 2026 (one query per day, so no page cap truncated a day), and the jobs of every
completed, non-cancelled run were fetched. Job logs could not be read from this environment
(the log download redirects to blob storage the proxy denies), so the plan mode is inferred from
the jobs: no `build` and no `e2e` means the heavy tier was skipped (draft); `build` without
`e2e` means `skip`; `e2e (n)` jobs with a shard total below 8 mean `subset`; a shard total of 8
with a median shard time of at least seven minutes means `full`, and 8 shards with shorter
shards means a large subset (29 or more specs). PR base branches come from the pull-request
list matched on head branch. Cancelled runs (superseded by a newer push) are counted but have
no plan. **Gap:** the API returns no Actions runs of any workflow between 2 and 8 October 2026
inclusive, although promotions merged and tags were created in that period (section 4); the
window therefore covers 24 September to 1 October and 9 to 15 October.

Window totals: 5,542 `ci.yml` runs, of which 5,135 were `pull_request` events; 1,449 of those were
cancelled by a newer push and have no plan. Pull requests into `main` with a completed,
non-cancelled run: 2,967 runs over 498 PRs. "Ready" below excludes drafts (heavy tier not
dispatched) and runs whose `precheck` failed before planning: 2,342 runs.

| Plan on a PR into `main`          | Runs  | Share of ready runs | Runs with an e2e failure | Median e2e job-minutes | Median e2e wall (min) | Median run wall (min), p90 | Total e2e job-minutes |
| --------------------------------- | ----- | ------------------- | ------------------------ | ---------------------- | --------------------- | -------------------------- | --------------------- |
| `full` (8 shards, whole suite)    | 1,561 | 66.7 %              | 220 (14.1 %)             | 74.4                   | 13.1                  | 29.9, 45.7                 | 119,265               |
| large `subset` (8 shards)         | 278   | 11.9 %              | 14 (5.0 %)               | 33.5                   | 6.3                   | 21.2, 39.6                 | 9,751                 |
| small `subset` (1 to 7 shards)    | 99    | 4.2 %               | 2 (2.0 %)                | 1.6                    | 1.6                   | 15.5, 26.8                 | 367                   |
| `skip` (no shards)                | 404   | 17.3 %              | 0                        | 0                      | 0                     | 13.0, 21.6                 | 0                     |
| draft, heavy tier not dispatched  | 462   | excluded            | 0                        | 0                      | 0                     | 12.8, 20.0                 | 0                     |
| `precheck` failed before planning | 163   | excluded            | 0                        | 0                      | 0                     | 5.2                        | 0                     |

Other events in the same window: 13 of 13 completed pushes to `release` ran 8 full shards (one
more failed in `precheck`); 186 pushes to `main` ran the light tier with no e2e; 11 of 11 nightly
schedules ran full and passed; 117 runs on PRs stacked on another PR's branch, 108 of them
`full`. Two thirds of ready PR runs into `main` therefore pay the whole suite, about 74 e2e
job-minutes and a 30-minute wall clock each, against 13 minutes for a `skip` run; `full` runs
alone consumed about 1,990 e2e job-hours in the two weeks with data. 287 of the 498 PRs had at
least one `full` run, and 247 never had a thinned run at all. The `ci-full` label was present on
456 of the 1,561 `full` runs (29 percent), from 45 PRs; a single labelled PR re-runs the whole
suite on every push. e2e failed in 14 percent of `full` runs; this audit cannot say how many of
those were real regressions rather than runner or shard problems, which is exactly the
classification the shadow run has to add.

### Why the `full` runs were full

The plan reason is not recoverable from the API, so the oracle was replayed offline: for the
most recent 120 distinct `full` heads among ready PR runs into `main`, the head was checked out
in a detached worktree and its own `scripts/test-oracle.mts --json` was run against the
merge-base with `main`.

| Reason the plan was `full`                            | Heads | Of 120 | What it was                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A `BROAD_PATTERNS` hit                                | 62    | 52 %   | Most often `src/preload/index.ts` (30) and `src/preload/api.d.ts` (29), `src/renderer/demo/demo-api.ts` (26), `src/main/index.ts` (18), `tests/e2e/helpers/screenshot.ts` (17), `src/shared/demo-scenarios.ts` (14), `package.json` (12), `tests/e2e/helpers/seed-config.ts` (11), `tests/demo/*` (7 to 11 each), `scripts/build.mts` (9), `wdio.conf.ts` (8). Any new IPC channel touches preload and the demo API, so an ordinary feature PR is broad by construction. |
| `ci-full` label                                       | 35    | 29 %   | `precheck` exits before the oracle; the label stays on for the life of the PR.                                                                                                                                                                                                                                                                                                                                                                                           |
| HIGH confidence but more than half the suite selected | 15    | 13 %   | Over-selection by the selector vocabulary and the import graph, not by real coupling: `src/main/services/security/permission-policy.ts` and `read-outside-project.ts` each select 402 of 404 specs because the text token `Settings` (and single-letter tokens such as `A`, `C`, `rect`) appears in them; `src/renderer/controller/message-queue.ts` selects 405 of 407 because a shared e2e helper imports it.                                                          |
| Replay now plans `subset` or `skip`                   | 8     | 7 %    | The tree changed between the run and the replay, or the base at run time differed from today's merge-base. Within the method's error.                                                                                                                                                                                                                                                                                                                                    |
| LOW confidence (unmapped shipped source)              | 0     | 0 %    | Unmapped files did occur (`src/shared/api-protocol.mts` in 25 heads, `src/shared/skills` in 3) but always alongside a broad hit, which takes precedence.                                                                                                                                                                                                                                                                                                                 |
| No merge-base, `update-screenshots`, stack tip        | 0     | 0 %    | None in the sample; 28 `full` runs in the whole window carried `update-screenshots`.                                                                                                                                                                                                                                                                                                                                                                                     |

Two conclusions follow for the design. First, the LOW-confidence rule is not what makes PRs pay
for the full suite today; broad patterns and over-matching selectors are, and both are properties
of the mapping that the smoke inventory and a stoplist fix can address without touching the
fail-safe. Second, the `ci-full` label is a third of the cost and is a human choice, so any
measurement of a new gate has to report labelled and unlabelled runs separately.

## 3. Smoke inventory proposal

### Shape

A smoke set is a fixed list of specs that run on **every** ready PR into `main` that dispatches
e2e at all, in addition to whatever the oracle selects. It is not a replacement for affected
specs and not a replacement for `full` where `full` is forced. Its job is to catch the class of
regression a selector-mapped subset structurally cannot see: the app fails to boot, a shared
surface stops rendering, a native boundary (terminal, git, file dialogs, browser pane) breaks,
or the mock agent loop stops producing tool cards. Each spec must satisfy:

- it already exists in `tests/e2e` and is in the CI suite (not in `wdio.ci.conf.ts` excludes
  and not in the [exclusions inventory](../../tests/e2e/exclusions.json));
- its recorded median duration in [`scripts/e2e-shard-weights.json`](../../scripts/e2e-shard-weights.json)
  is at most 15 seconds, so the whole set stays under about three minutes of spec time and
  fits in two shards;
- it drives a surface through real product paths (seeded config, mock models, real IPC), with
  no live service and no real model;
- its first-attempt pass rate over the shadow window (section 5) is at least 98 percent; a spec
  below that is replaced, not retried harder.

### Seed list

Twenty specs, about 175 seconds of recorded spec time. Durations are the committed medians
(measured 8 October 2026 over 160 shard logs).

| Spec                              | Surface it guards                                    | Median s |
| --------------------------------- | ---------------------------------------------------- | -------- |
| `smoke.e2e.ts`                    | App boots; `#app` and layout landmarks exist         | 1.9      |
| `theme-boot.e2e.ts`               | Theme and tokens applied before first paint          | 7.6      |
| `titlebar-icons.e2e.ts`           | Titlebar panel toggles                               | 4.8      |
| `composer-surface.e2e.ts`         | Composer renders and accepts input                   | 6.5      |
| `thread-sidebar-selection.e2e.ts` | Thread list, selection, sidebar styling              | 6.5      |
| `command-palette.e2e.ts`          | Command palette and sidebar thread filter            | 8.5      |
| `file-search-palette.e2e.ts`      | Quick-open file search over the workspace index      | 5.3      |
| `settings-save.e2e.ts`            | Settings open, edit, persist round trip              | 7.2      |
| `appearance-settings.e2e.ts`      | Appearance settings live preview                     | 6.7      |
| `panel-position.e2e.ts`           | Right panel position setting and layout              | 7.3      |
| `terminal-display.e2e.ts`         | Integrated terminal (native pty)                     | 12.8     |
| `git-changes.e2e.ts`              | Git changes viewer against a real repository fixture | 11.7     |
| `markdown-conformance.e2e.ts`     | Streaming markdown renderer                          | 6.6      |
| `tool-display-live-mock.e2e.ts`   | Mock agent loop produces tool cards                  | 7.7      |
| `worktree-preparation.e2e.ts`     | Worktree preparation tool cards                      | 7.7      |
| `activity-panel.e2e.ts`           | Activity panel                                       | 13.4     |
| `pr-panel.e2e.ts`                 | PR panel over the mock `gh`                          | 14.1     |
| `browser-display.e2e.ts`          | Browser pane                                         | 6.5      |
| `new-project-flow.e2e.ts`         | Add project, project switch                          | 12.6     |
| `acp-startup-tools.e2e.ts`        | ACP adapter startup and failure surfacing            | 7.7      |

`onboarding.e2e.ts` is the obvious boot spec but is in the exclusions inventory and is left out
until that entry is resolved. Roadmap, automation, SSH and remote surfaces have no seed entry;
they are covered by affected-spec selection and the area rule below, and the shadow run decides
whether one spec each should join.

### Ownership mapping

The oracle already owns a mapping from changed files to specs: the import graph plus each
spec's selector vocabulary (`scripts/test-oracle.mts` 734-840), kept live by
`npm run check:oracle` ([`scripts/check-oracle.mts`](../../scripts/check-oracle.mts) 42-60). The
smoke inventory builds on that rather than beside it:

- A committed inventory, proposed at `tests/e2e/smoke-inventory.json`, lists each smoke spec
  with the **source areas** it stands in for, as path prefixes: for example
  `terminal-display` for `src/main/services/terminal/` and `src/renderer/views/terminal/`;
  `git-changes` for `src/main/services/git*` and `src/renderer/views/changes/`;
  `tool-display-live-mock` for `src/main/agent/` and `src/renderer/views/tool-cards/`;
  `settings-save` and `appearance-settings` for `src/renderer/views/settings/` and
  `src/main/settings/`; `smoke` and `theme-boot` for everything under `src/renderer/styles/` not
  already broad, `src/renderer/app/` and `src/main/window*`.
- The inventory is derived, not invented: the seed areas come from the oracle's own `--explain`
  reasons for each smoke spec, trimmed to prefixes, and the shadow run reports which unmapped
  files fell into no area.
- `check:oracle` gains three invariants: every smoke spec is live (already enforced for all
  specs); every smoke spec resolves to at least one area; and a fixed list of top-level areas
  (`src/main/services/*`, `src/main/agent`, `src/renderer/views/*`, `src/renderer/markdown`,
  `src/shared`, `packages/*/src`) each has at least one smoke spec or an explicit
  `"smoke": null` entry meaning "no smoke spec; LOW confidence here still runs full".

### Selection rule for the proposed small gate

Written as the rule the shadow run evaluates; today's rule stays in force.

1. **Broad change.** A broad change is any of: a `BROAD_PATTERNS` hit; an unknown change set
   (no merge-base); a declared screenshot stack tip; the `ci-full` or `update-screenshots`
   label; or a base of `release`. A broad change runs **full**, exactly as today. The pattern
   list is the definition; widening or narrowing it is a reviewed change to the oracle with an
   invariant, not a judgment call per PR.
2. **HIGH confidence.** Run the oracle's affected specs **plus the smoke set**. This is strictly
   more than today's `subset`.
3. **LOW confidence.** For each unmapped file, add every smoke spec whose area contains it and
   every spec whose selector vocabulary or imports touch any file in that area (the area
   expansion). If any unmapped file falls in no area, or the expansion would exceed half the
   suite, run **full**. LOW confidence therefore expands coverage; it never omits an unknown
   surface, and the fallback for a surface nobody has mapped is the whole suite.
4. **Nothing selected.** `skip` stays `skip` only for diffs that touch no shipped source and no
   spec; the smoke set does not run on docs-only changes.
5. **Promotion, nightly and labels** are untouched: full suite plus bench, as today.

Test count alone is not the rule: the half-suite cap is a cost guard that sends a large selection
to `full`, never a reason to drop specs. The rule changes what a LOW-confidence PR runs from
"everything" to "everything related plus smoke", and the shadow run has to show what that misses.

## 4. Promotion attestation

### What is immutable today

- The promotion head `promote/main` is a branch the workflow points at the `main` SHA it read,
  fast-forwarded only (`updateRef` with `force: false`) and deleted on merge
  (`promote-develop.yml` 72-112). Later merges to `main` cannot move the candidate or cancel
  its CI. `autoformat` is excluded on promotions so no commit can be added to that head
  (`ci.yml` 633-636, 665).
- The promotion merges with a merge commit (`enablePullRequestAutoMerge` with `MERGE`, 163-174;
  the `release` ruleset allows only `merge`), so every promoted `main` commit stays an ancestor
  of `release`, and `promote-develop.yml` 80-90 checks completeness by ancestry, not by tree.
- `release-cut.yml` tags the pushed SHA (`github.sha` on a push, 32-47), reads the version from
  that commit, refuses to re-tag a version that exists at another commit (101-109), and
  dispatches `release-mac.yml` at the tag.
- `release-mac.yml` resolves the tag to a commit from its own checkout, requires the version to
  match, requires reachability from `release`, and waits for a `CI Passed` check run on exactly
  that SHA (68-138). It builds from `needs.preflight.outputs.release_sha`, never from a branch
  name (153, 179), and names the artifacts after that SHA (355).
- `release-publish.yml` is manual, re-verifies tag, version and ancestry, requires the supplied
  source run to be a successful `release-mac.yml` run whose `head_sha` equals the tag commit
  (86-102), re-checks `SHA256SUMS` (122-137) and attests the files when the repository is public.

### What is missing to say "release exactly the tested candidate"

1. **The commit that ships is not the commit the full tier tested.** The promotion PR's full run
   tests the PR merge ref (promote/main merged onto `release` at that moment). The merge commit
   that lands on `release` is a new SHA. Its `CI Passed` comes from the **push** run, whose plan
   is oracle-decided (section 1). The tag is cut on the merge commit, and `release-mac.yml` is
   satisfied by that push run. So the statement that holds today is "the released commit's tree
   equals a tree that passed the full tier, provided `release` did not move between the PR run
   and the merge", and the workflows do not check that proviso. With `release` receiving only
   promotions and hotfixes, the proviso usually holds, but nothing records it.
2. **Evidence is not durable.** Check runs and workflow runs are the only link from a tag to its
   validation, and both can disappear. Observed on 15 October 2026: the Actions API lists no run
   of any workflow between 2 and 8 October 2026; promotions #3400, #3437, #3439, #3481, #3520,
   #3565 and #3572 merged in that window; tags `v0.1.0-beta.12` (`f4035f886`), `v0.1.0-beta.13`
   (`54b703592`) and `v0.1.0-beta.14` (`d2c497e8d`) point at promotion merge commits from it;
   none of those three commits, nor the heads of #3400 and #3565, has any check run today; and
   `release-mac.yml` has no run for any of the three tags (its last runs are the failed
   `v0.1.0-beta.9` to `beta.11` on 26 to 29 September). Whatever the cause (deleted runs, a
   period with Actions unavailable, or a different path that created those tags), the record
   cannot now show those three versions passed anything. "Release exactly the tested candidate"
   needs evidence that survives the run.
3. **Tags are lightweight and unprotected.** `git/ref/tags/v0.1.0-beta.14` is a lightweight tag
   on a commit. No ruleset targets tags, so a `v*` tag can be moved or deleted by anyone with
   write access; `release-publish.yml` would still refuse a run whose `head_sha` differs, but
   only while that run exists, and a moved tag with a new dispatch produces a fresh run that
   passes every check in `release-mac.yml`.
4. **Nothing binds the tag to a plan.** Neither the tag, the promotion PR nor the release notes
   record the CI run id, the e2e plan (`full` versus oracle-thinned on the push run), the shard
   outcomes or the promotion head SHA that was tested.

### First implementation: exact-commit release gate

The release-validation change implements the immediate enforcement slice:
release-branch and `v*` tag pushes force full unit/e2e plans, and a separate
`Full release validation` aggregate requires all eight shards and full-tier
prerequisites. Packaging verifies CI workflow provenance for the exact commit;
publication revalidates the pinned run attempt. `RELEASE_VALIDATION.json` is
checksummed and published with the binaries, retaining the evidence beyond
Actions retention. See [the release contract](../releasing-macos.md#exact-commit-full-validation).

This does **not** complete the attestation exit criterion below. A real release
must exercise the path; per-spec result digests, promotion-parent linkage, and
immutable tag rules remain outstanding. The shadow selector still changes no gates.

### Remaining attestation design

- At promotion merge, write a small record: promotion PR number, `promote/main` head SHA,
  `release` base SHA at PR run time, the PR run id and its merge-ref SHA, the push run id, both
  plans (`full` expected), and a digest of per-spec results. Store it where the screenshot
  baselines already live (immutable object storage, see
  [screenshot review packets](../screenshot-review-packets.md)), keyed by the `release` merge
  commit, and link it from the promotion PR.
- `release-cut.yml` reads that record before tagging and refuses when it is missing, when the
  push run's plan was not `full`, or when the `release` base recorded at PR run time is not the
  parent of the merge commit (the proviso in point 1). The tag then names a candidate whose full
  tier evidence is on file.
- Implemented: force full unit/e2e plans for release-branch and release-tag pushes, so the
  commit that ships has its own complete run rather than inheriting one by construction.
- Add a tag ruleset for `v*` that forbids update and deletion, and create annotated tags whose
  message carries the record key.
- Beyond the enforcement slice above, these are future PRs.

## 5. Shadow-run design

The gate itself does not change until the shadow run has produced the evidence below, and the
gate change is a separate PR with its own review. The shadow run is advisory and additive.

### Prerequisite: per-spec results that outlive the run

Today a shard's per-spec outcome exists only in its job log, which this audit could not read
and which the record above shows can vanish. Each e2e shard should upload a small JSON artifact
(spec path, attempt, outcome, duration, failure class) and the plan step should upload the plan
it emitted. Both are a few kilobytes and belong with the screenshot evidence in immutable
storage so the replay below does not depend on log retention.

### Replay

For every ready PR into `main` whose plan was `full` (and, as a control, every `subset` run):

1. Reconstruct the inputs: the head tree, the merge-base with the base at run time (from the
   run's `pull_request.base.sha`), and the oracle at that head.
2. Compute the proposed plan from section 3 offline, with the head's own
   `scripts/test-oracle.mts --json` plus the smoke inventory and area expansion.
3. Take the actual per-spec outcomes from the run. Classify each failing spec as **real** (failed
   on both attempts, and the PR's next push changed shipped source or the spec, or the PR was
   closed as broken) or **not real** (passed on attempt 2, runner provisioning error, download
   or dist failure, cancelled shard). The classification is recorded with the evidence, never
   inferred later from memory.
4. A real failure is **missed** when its spec is not in the proposed plan for that run.

Report, per week and cumulatively: full runs replayed; real failures; missed real failures; the
specs most often missed and which area rule would have caught them; proposed e2e job-minutes
against actual; proposed e2e wall time against actual. Also record promotion outcomes in the
same weeks: red promotions, and for each whether the failing spec would have run on the PR
under the proposed rule.

### Live shadow

Alongside the offline replay, `precheck` emits the proposed plan as an extra output and a
neutral, never-required check (`Small gate (shadow)`) posts "would have run N specs on S shards;
actual plan M" on the PR. No job consumes it; it exists so that the plan logic runs on real
events, including labels, drafts, forks and stack tips, before anyone trusts it.

### Numbers to report before and after

| Measure                                            | Before (section 2 window)                                   | Target after                               |
| -------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Share of ready PR runs into `main` that run `full` | 66.7 % (1,561 of 2,342)                                     | below a third, by construction of the rule |
| Median e2e job-minutes per `full` PR run           | 74.4 (13.1 min wall)                                        | the proposed plan's minutes, replayed      |
| Median CI wall time, ready PR into `main`, `full`  | 29.9 min, p90 45.7                                          | measured in the live shadow                |
| Promotion PR open to merge, median and p90         | 39 min median, 16.4 h p90 (24 promotions, 23 Sep to 14 Oct) | unchanged or better; the full tier stays   |
| Real e2e failures on `full` PR runs                | 220 runs with an e2e failure (14.1 %); real share unknown   | counted per week in the replay             |

### Exit criteria (all required before a gate-change PR is opened)

- At least four weeks of live shadow and at least 300 replayed `full` runs, whichever is later.
- Missed real failures at most one in twenty real failures, and zero missed failures that a
  promotion then caught on `release` in the same period.
- Every missed failure has an inventory change (a new area or smoke spec) that would have caught
  it, re-run through the replay.
- Smoke set first-attempt pass rate at least 98 percent; no smoke spec appears in the exclusions
  inventory.
- Promotion attestation from section 4 is in place, so the release gate is demonstrably complete
  before the main gate shrinks.
- The gate-change PR itself lands with the invariants in `check:oracle`, the updated
  `docs/testing-strategy.md` table, and this plan moved to Active.

### Kill criteria (stop the shadow and keep today's gate)

- Two or more real failures missed in any two-week window after the inventory was adjusted once.
- A regression reaches a release tag that the full PR tier would have caught and the proposed
  plan did not run.
- The smoke set's flake rate stays above 2 percent after two replacements.
- The replay cannot classify failures because per-spec results are missing for more than 10
  percent of runs; fix the evidence pipeline first.

## Unresolved findings

- Why the Actions API shows no runs between 2 and 8 October 2026, and who created
  `v0.1.0-beta.12` to `beta.14` and on what evidence. This needs an owner with repository
  settings and audit-log access.
- Whether the merge-queue documentation should be corrected to "no queue" or the queue enabled;
  either way the gate design must not depend on the answer.
- Release pushes now force `full`; observe a real promotion and release through the new
  exact-commit gate before treating the release assurance prerequisite as proven.

## First implementation slice

The additive evidence pipeline and advisory selector are documented in
[the first-slice report](main-gate-shadow-first-slice.md). This leaves the policy and exit criteria
above unchanged; the historical replay and live reliability window remain outstanding.

## Next action

Open the per-spec result artifact and plan artifact as the first implementation PR (it is
needed by the replay, by attestation and by the screenshot work in the recovery plan), then run
the offline replay against the window above and publish the first report in this plan's PR
thread. Keep the gate change separate.
