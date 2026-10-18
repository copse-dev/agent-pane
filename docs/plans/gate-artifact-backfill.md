# Structured gate evidence backfill

## Task brief

Recover surviving structured artifacts for the 300 candidates in the first daily
gate report. Preserve artifact IDs, original ZIP digests, runtime-context sources
and reconstruction provenance. Validate candidate identity, every shard and
attempt, and reproduce the report with the existing reporter. Missing context,
coverage or failure classifications must remain explicit. Do not change main's
gate or represent reconstructed records as native publisher evidence.

Scope: structured plan/outcome artifacts only; no general historical log parser.
Read precheck logs only to recover explicitly recorded runtime context.

## Result

The fixed 300-run cohort from [the first daily report](https://github.com/copse-dev/agent-pane/actions/runs/39042075411)
now has **five complete full replays**, one execution-complete run awaiting
failure classification, four existing E2E-skip records and 290 missing records.
There are no invalid records. The missed-real-failure fraction remains `null`,
not zero, because no real failures have been classified in the recovered cohort.
Gate readiness remains false and estimated savings remain zero.

| Recovered run                                                                   | Candidate  | Result                                                                                               |
| ------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| [39034010882](https://github.com/copse-dev/agent-pane/actions/runs/39034010882) | `8402c3fc` | Complete full replay, 403 outcomes                                                                   |
| [39012068789](https://github.com/copse-dev/agent-pane/actions/runs/39012068789) | `2fc2608b` | Complete full replay, 403 outcomes                                                                   |
| [39010088468](https://github.com/copse-dev/agent-pane/actions/runs/39010088468) | `2fc2608b` | Complete full replay, 403 outcomes                                                                   |
| [38911917469](https://github.com/copse-dev/agent-pane/actions/runs/38911917469) | `1cde33c0` | All 403 specs covered, 454 outcomes; repeated `create-pr-dialog.e2e.ts` failure remains unclassified |
| [38911801213](https://github.com/copse-dev/agent-pane/actions/runs/38911801213) | `1cde33c0` | Complete full replay, 403 outcomes                                                                   |
| [38905706139](https://github.com/copse-dev/agent-pane/actions/runs/38905706139) | `1cde33c0` | Complete full replay, 403 outcomes                                                                   |

All six runs belong to the shadow-instrumentation PR and span only three
candidate commits. Every recorded proposed plan was full (the E2E configuration
was a broad hit). These are useful full-plan controls, not six independent
regressions or evidence that a smaller selection catches failures. The two green
runs on the dialog failure's candidate do not establish the required failure
classification; no label was inferred from those separate runs.

## Retained evidence and verification

- [Discovery results](evidence/backfill-discovery.json) record the exact-attempt
  plan-artifact lookup for all 296 previously missing runs: six present, 290 absent.
- [Report](evidence/gate-structured-backfill-report.json) uses the unchanged reporter
  from main commit `36ee5e42b170323020c88096c84052892aa3edce`.
- [Evidence bundle](evidence/gate-structured-backfill-2026-10-17.zip) retains all
  54 original GitHub artifact ZIPs, their IDs and API digests, six reconstructed
  records, four previously published records, the 300-entry manifest, report and
  per-run audit. This repository copy survives Actions artifact expiry.

Bundle SHA-256: `fbcc2910de5461a65003f4c65525bb8487cc1653178e2160dc262fe3730d25aa`.

Every original ZIP matched its GitHub SHA-256. Every recovered outcome matched
the run, workflow attempt, candidate commit, shard and planned spec. No duplicate
spec/attempt observations or unfinished observations were accepted. All eight
shards were present, all 403 specs had first-attempt observations, and each spec
stayed on one shard. The shadow plan's actual E2E mode/specs/shards agreed with
the separate selected-plan artifact.

Older plan artifacts omitted `baseRef`. Reconstruction adds only `plan.baseRef`
from consistent timestamped `BASE_REF: main` precheck log lines. The same logs
confirm base/head SHAs, draft state and labels against the original plan.
Each record explicitly carries `reconstructed-from-structured-artifacts`
provenance, supplemented fields, job URLs and context excerpts. The original
plan bytes remain untouched inside their retained ZIP. These records were not
published as native `ci-evidence/v1` objects.

To reproduce the report from the repository root with dependencies installed:

```sh
mkdir -p /tmp/gate-backfill-audit
unzip docs/plans/evidence/gate-structured-backfill-2026-10-17.zip -d /tmp/gate-backfill-audit
node scripts/report-gate-evidence.mts /tmp/gate-backfill-audit/manifest.json > /tmp/gate-backfill-report.json
cmp /tmp/gate-backfill-report.json /tmp/gate-backfill-audit/report.json
```

The reporter validates every manifest record digest and candidate identity.
`audit.json` additionally maps each original ZIP to its API digest and records
per-shard counts and runtime-context provenance for independent inspection.
Independent bundle verification reproduced the report byte-for-byte, compared
all six reconstructed plans with their original plan plus the declared base-ref
supplement, and compared all reconstructed outcomes with the original shard
JSON. Formatting and whitespace checks passed. No executable repository code,
workflow or gate was changed, so application tests were not rerun for this
evidence-only change.

## Boundary and next step

This is a retained, fixed-cohort historical backfill. The daily rolling report
continues to collect native publisher records; it does not silently import this
manually reconstructed cohort or double-count it. A combined longitudinal report
must deduplicate by run/attempt and retain the distinction in provenance.

The structured-artifact backfill for this cohort is exhausted. Continue live
capture and failure classification, plus the required observation window and
promotion evidence. Do not relax the gate based on these five full-plan controls.
A general parser for the other 290 historical runs is a separate investment,
not an assumed source of 290 successful replays.
