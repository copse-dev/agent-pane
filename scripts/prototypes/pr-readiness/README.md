# Current-head PR readiness prototype

Task brief: establish a deterministic readiness decision before adding the shipping loop in
#873. This is a standalone, read-only
prototype with no renderer, live agent, permission, persistence or merge-policy changes.
It does not close #873, #690 or #3073.

Acceptance criteria:

- A pass for an older head, changed base, other PR/repository or different checked commit cannot
  establish readiness. It remains historical evidence.
- Newer workflow runs supersede earlier suites only for the same provider, workflow and check.
  A late rerun of an older workflow run cannot hide a newer run's failure. A similarly named
  check from another provider, workflow or legacy status cannot hide a failure.
- Incomplete reads, missing results, unknown states, skipped tests, stale approvals and expired
  observations cannot produce `ready`. Failures remain visible alongside pending work.
- A live observation re-reads the same PR and evidence to detect changes during collection.
- Every requirement reports its evidence, gap and next responsible actor. GitHub success alone
  cannot establish local, visual or runtime acceptance.

## Run

```sh
pnpm run prototype:pr-readiness -- --repo copse-dev/agent-pane --pr 4018
pnpm run prototype:pr-readiness -- --snapshot snapshot.json
pnpm test -- scripts/prototypes/pr-readiness
```

The live command uses two bounded, read-only `gh api graphql` requests to github.com through the
existing GitHub CLI login. Each request has a 30-second timeout and 512 KiB output limit. No
checkout, fetch, push, rerun, review, comment, merge or model invocation occurs. It prints
`{ snapshot, decision }` JSON. Exit 0 means the supplied declared evidence is ready; exit 2 means
the decision is blocked, waiting or unknown; exit 1 means no valid observation could be obtained.
The package runner may print its own banner; invoke `node scripts/prototypes/pr-readiness/cli.mts`
directly when redirecting JSON into a snapshot record.

Offline mode expects the `snapshot` object, not the complete printed envelope. Its shape is
defined and validated by `readinessSnapshotSchema`. Snapshots are data supplied by a collector,
not signed attestations or execution authority. Do not use an agent-authored snapshot to approve
publication. No CLI path performs a write even when a decision is `ready`.

## Decision and observation boundaries

`assessPrReadiness(snapshot, now)` is pure and checks freshness against an injected clock. The
default observation lifetime is five minutes. A complete requirement inventory, confirmation of
the repository/PR/head/base, and a current passing result for every requirement are necessary.
Receipts compare `generation` first, then `sequence`, within one source. GitHub Actions uses the
workflow run number as the generation and the check-run database ID as the sequence. A newer
workflow run replaces older suites even if an older run is retried later. Older snapshot formats
default to generation zero. Contradictory outcomes at the same source/generation/sequence remain
unknown. Every receipt carries the PR identity and the provider-reported checked SHA; this first
prototype supports head evidence only, not an attestation of the CI process's actual checkout.

The GitHub adapter reads required contexts using GitHub's `isRequired`, preserves source
identity and checked commit, and uses GitHub's merge-rule evaluation instead of hardcoded check
names. Check sources use app ID, workflow ID and check name; checks without workflow metadata
retain separate suite identities rather than guessing that names establish supersession.
It also reads draft/conflict/review/discussion state. It is conservative: skipped/neutral checks
remain distinguishable from tests that ran; unresolved discussions and any latest review requesting
changes block even when GitHub's required-review verdict permits merging. `UNSTABLE` remains unknown
because non-required failures do not establish a required-rule failure. This observation adds those
explicit conservative limits; it does not change GitHub rules.

Three connections are capped at 100 records. A truncated page, GraphQL error, changed observation,
unavailable confirmation, or missing check identity makes coverage incomplete. There is no cache
or automatic retry. Test-merge checks are explicitly unsupported and prevent readiness when
present. A successful head check must not replace applicable test-merge or merge-queue evidence.

The live adapter deliberately adds an **unknown acceptance requirement**: it does not collect local
commands, working-tree fingerprints, visual/runtime evidence, human holds in descriptions/comments,
or a complete repository-rule inventory. Therefore the live command never reports overall ready
yet. This is a useful observation prototype, not a shipping gate. The offline evaluator can decide
complete fixture inventories; caller-supplied completeness is a contract, not something it can
discover from missing data.

## Next integration

Add a host-owned requirement/evidence collector using the existing command-phase and thread
records; bind local results to actual checked contents, including uncommitted changes. Enumerate
repository rules and missing required contexts, paginate evidence, support verified test-merge
and merge-group ancestry, and include explicit holds. Re-read at action time and guard writes by
the approved head; a five-minute-old readiness observation never grants permission.

Only then expose this decision in the app, with focused WebdriverIO DOM assertions and screenshots.
Reuse the existing supervisor, CI watch, approval gates and continuation budget for the later fix
loop. Investigator graduation and PR review-reply routing remain separate work.

Validation results and the final source SHA belong in the draft PR. The focused suite tests pure
decisions and the actual observation adapter at its read boundary. No app visual evidence is
needed for this slice because no app code or rendered surface changes.

References: [GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
[GraphQL checks](https://docs.github.com/en/graphql/reference/checks).
