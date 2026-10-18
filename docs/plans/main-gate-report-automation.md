# Automated gate reports and historical backfill sample

## Task brief

Capture evidence after each CI run (existing publisher), aggregate the latest 300
completed PR CI runs daily and on demand, and retain reports beyond Actions'
observed five-day expiry. Acceptance: trusted main-only execution, read-only
GitHub access, no gate changes, partial collection clearly marked, immutable R2
write plus digest-verified read-back, downloadable manifest/records/report, and a
small cited historical sample assessing backfill feasibility.

The `Gate shadow report` workflow runs daily at 04:17 UTC, manually on main, and
when its implementation lands on main. It deliberately does not rescan 300 runs
on every PR: per-run evidence is already written by `Publish gate evidence`.
The default token has only contents/actions/checks read access. R2 credentials
are available only to the trusted archive step. Reports cannot authorize merges.

Each execution uploads an Actions artifact and archives a bundle of the report
and manifest under `ci-reports/v1/<run>/<attempt>/<sha256>.json`, using conditional
creation and digest-verified authenticated read-back. Source records remain at
`ci-evidence/v1/<run>/<attempt>/<sha256>.json`; their keys can be reconstructed
from the archived manifest. Collection failure leaves the job red, but a partial
manifest/report can still be archived with `collectionOutcome: failure`. Never
interpret a partial or zero-record report as a zero-miss result.

Actions requests 90-day retention but currently caps it at five days. The R2
bundle retains the report and discovery manifest beyond that expiry. Manual
classification is still a reviewer task; the automation does not invent labels
from retries or subsequent green runs.

## Historical sample (17 October 2026)

The three most recent failed PR CI runs at sampling time cover two candidates,
not three independent regressions. Timestamped context and failure excerpts,
artifact IDs and digests are retained in
[`gate-backfill-sample.json`](evidence/gate-backfill-sample.json).

| Run                                                                             | Observed failure                                                                   | Recoverability and classification                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [39011670753](https://github.com/copse-dev/agent-pane/actions/runs/39011670753) | `pnpm-exec-format-check.e2e.ts` fails both outer attempts; other seven shards pass | No structured plan/outcomes. Precheck logs retain base/head, ready/main context, labels and full 404-spec plan. Real under the shaping plan definition, with the cited fixture fix below. |
| [39009358898](https://github.com/copse-dev/agent-pane/actions/runs/39009358898) | Same spec fails both attempts on the same candidate                                | Same log-only limitation and classification; do not count as another independent regression.                                                                                              |
| [38911917469](https://github.com/copse-dev/agent-pane/actions/runs/38911917469) | `create-pr-dialog.e2e.ts` fails both attempts; other seven shards pass             | Plan and all eight outcome artifacts exist. Inspected plan and failed-shard bytes: actual/proposed both full 403, with `wdio.ci.conf.ts` a broad hit. Classification remains unknown.     |

[e9d9bb66](https://github.com/copse-dev/agent-pane/commit/e9d9bb66f7931f23623941cdfdaa11bff2d53982)
directly follows the first two runs' PR head and fixes the failing fixture by
recursively resolving copied dependency links. This supports the plan's
repeatable-failure-plus-spec-fix definition of real; it is a test fixture defect,
not evidence of a product regression. The later run was still running when the
fix was pushed. No equivalent classification evidence was established for the
dialog failure; a green retry alone would not establish it.

The third run's downloaded plan and shard-4 ZIPs were checked against their API
SHA-256 digests. The failed shard contains 102 outcome rows (51 specs across two
attempts), all belonging to the actual plan. This establishes that its failing
spec was selected by the recorded shadow. The other seven outcome artifacts
have not been downloaded or validated, so this is not a complete replay.

Backfill is feasible first for instrumented runs with surviving artifacts.
Older log-only runs need a parser that proves coverage across every shard and
attempt, plus replay of the selector against pinned historical trees. Neither
log-only candidate has been qualified for a missed-failure calculation here.
Missing runtime fields must be supplemented with explicitly cited precheck
logs, preserving the original artifact digests and reconstruction provenance.
Do not silently turn reconstructed data into native publisher evidence.

One concrete trap: the API's associated `pull_requests[].head.sha` had advanced
to the fixture-fix commit while the run's top-level head and runtime `HEAD_SHA`
still identified the tested commit. Use runtime evidence for historical context;
current PR metadata cannot reconstruct it reliably.

This sample does not satisfy the 300-full-replay or observation-window criteria.
Keep the main gate unchanged. Prefer automatic capture of new runs, then a
separate bounded artifact-backfill implementation before investing in a general
historical log parser.
