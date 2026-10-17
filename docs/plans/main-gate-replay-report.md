# Main-gate replay report pipeline

Status: measurement only. No required check or selector policy changes.

## Task brief

Turn durable shadow records into a reproducible multi-run report. Acceptance:
verify object digests and candidate/run/attempt provenance; never count absent,
unclassified or incomplete evidence as a completed replay; deduplicate workflow
reruns; report weekly and labelled/unlabelled cohorts, known real misses, and
smoke first-attempt reliability. Keep spec-work estimates separate from measured
CI time. Verify the first live publisher independently before claiming storage
works. The four-week shadow and 300 qualifying full replays remain outstanding.

## Collect and report

From a machine where authenticated `gh api` can read the repository:

```sh
node scripts/collect-gate-evidence.mts /tmp/gate-evidence 300
node scripts/report-gate-evidence.mts /tmp/gate-evidence/manifest.json > /tmp/gate-report.json
```

Use a fresh output directory for each collection; existing manifests are never overwritten.
Collection reads the newest completed pull-request CI runs. It paginates and
caches checks per head, accepts only the configured public R2 origin and exact
run/attempt/digest paths, rejects redirects, bounds downloads, verifies SHA-256,
and checkpoints the manifest after each run. It performs no GitHub or R2 writes.
A missing record, unavailable API, or failed download remains an explicit gap.
The collector does not execute historical repository code.

The manifest entries identify `runId`, `attempt`, `head`, and `createdAt` from
GitHub. Downloaded records add relative `record` and `sha256` fields. Add optional
`classifications` arrays containing `spec`, `classification` (`real` or `not-real`)
and a cited `evidence` URL, following the shaping plan's definition. Classification
is a human/reviewer judgment: the report checks structure and binding, not the
truth of the linked evidence. Duplicate or unrelated classifications are rejected.

Only recorded ready PRs targeting main are included. This change records
`baseRef` in future plans; older records without that context are excluded, not
classified using the PR's current mutable base. Only the newest workflow attempt
per run is counted. Missing current-attempt outcomes remain incomplete. A known
real miss stays visible even if other specs in its run are incomplete; the rate
uses only complete runs. Empty real-failure denominators produce null, not zero.

The report includes complete full replays, subset controls, weekly and label
breakdowns, per-run gaps and cited classifications in the input manifest, smoke
first-attempt observations/missing counts, and estimated saved spec-minutes.
Those estimates exclude setup, downloads, retries and queue time. Smoke worker
success does not prove a platform-skipped test executed. The report always leaves
`gateChangeReady` false: promotion comparisons, live-window coverage and the
remaining attestation criteria need independent evidence.

## Initial inventory: 17 October 2026

A read-only API inventory identified 300 completed PR CI candidate runs created
between 14 October 16:47:36 UTC and 17 October 12:48:46 UTC. This is a candidate
inventory, **not 300 full replays**. Historical per-spec records have not been
reconstructed; the bootstrap report marks all 300 missing and zero qualifying
replays. The candidate IDs and gaps are retained in
[`evidence/gate-shadow-initial-manifest.json`](evidence/gate-shadow-initial-manifest.json).
Reproduce that bootstrap report with:

```sh
node scripts/report-gate-evidence.mts docs/plans/evidence/gate-shadow-initial-manifest.json
```

The main publisher was activated by #3806 at
`8cde7304c4d6f9198c0d8c3754e68353d62c1b64`. Historic jobs without trustworthy
outcomes/runtime context require a separate reconstruction effort or must remain
gaps. The collector/report cannot manufacture that evidence. Once live records
accumulate, rerun collection and classify persistent failures before evaluating
savings or the shaping plan's exit criteria.

## Implementation validation

- 20 focused report, collector, selector and publisher tests passed, including
  pagination/check caching, digest and candidate rejection, deduplication,
  partial reruns, unknown classifications and known misses in incomplete runs.
- All `check:local` stages passed, including both TypeScript projects, type
  coverage, lint, formatting and repository invariants.
- Full `pnpm run check` reached the unit suite: 11,676 passed, 278 failed,
  9 cancelled and 10 skipped. Failures include unavailable native/runtime
  dependencies and process-lifecycle cases; not every failure was independently
  reproduced on the base. This is not a clean local full-suite pass.
- The bootstrap manifest reproduces 300 missing records and zero qualifying
  full replays. Live `gh api` collection is blocked by this cloud environment's
  Forbidden response; the collector's API boundary was exercised with fixtures.
