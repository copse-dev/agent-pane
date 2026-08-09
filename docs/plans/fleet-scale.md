# Working at fleet scale

**Status: Proposed.** Nothing here is implemented. This is an audit of what breaks when
one person supervises a fleet of agents rather than writing the code themselves, split
into what the CI should do differently and what the product should do differently.

Related: [`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md) (the PR/CI
nurse this argues to unblock), [`mission-control.md`](mission-control.md) (the activity
surface this argues to ship), [`background-supervisor.md`](background-supervisor.md) (the
scheduler both consume), [`../testing-strategy.md`](../testing-strategy.md) (where a test
belongs — this plan owns what happens when one stops being trustworthy).

## Why this plan exists

Two observations from outside the project, both correct, and they point at different
things:

> CI/CD tools have a lot of what you want … just need to look for it

> you need to think that you're a team of engineers not an engineer with agents and build
> out tooling accordingly

The first is a gap in **telemetry**. This repo has built an unusual amount of CI
_control_: oracle-driven test selection, a light/full tier split gated on `base_ref`, a
fail-closed aggregate check that reasons about supersession, an ephemeral self-hosted pool
serving both tiers, a host-local dependency store, and a promotion flow standing in for a
merge queue this org's plan cannot buy. It has almost no CI _reporting_. Across eighteen
workflows there is **one** `$GITHUB_STEP_SUMMARY` write in `ci.yml` and seven annotation
calls in 1,984 lines. Nothing anywhere persists what a run cost or why. Every question in
the audit below — why was that run 54 minutes, which shard queued, is that spec still
flaky — had to be answered by hand-reading the jobs API. Those are the platform features
that are already paid for and unused.

The second is a gap in **shape**. Both the repo and the product still assume one engineer
with helpers. Each agent run opens its PR and forgets it. Each CI failure is diagnosed
from scratch by whoever hits it next. Quarantined tests have no owner and no expiry. The
app's task list is scoped to the active thread. A team has things a soloist does not: a
shared memory of known failures, a board showing what everything is doing, a handover, and
a reviewer who is not the author. None of those exist yet.

## Evidence

Measured 2026-08-09 against `copse-dev/agent-pane`.

| Signal                                  | Value                                                                                       | Source                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Total `ci.yml` runs                     | 8,001                                                                                       | Actions API                                      |
| Open PRs                                | 25 (8 draft), oldest [#1392](https://github.com/copse-dev/agent-pane/pull/1392) open 9 days | PR list                                          |
| Agent-authored heads                    | `claude/`, `codex/`, `copse/` prefixes on 22 of 25                                          | PR list                                          |
| Run wall-clock                          | median 16.1 min, p90 30.2 min, max 54.1 min (23 completed of last 30)                       | Actions API                                      |
| Cancelled                               | 7 of 30 (~23%) — concurrency supersession                                                   | Actions API                                      |
| Failed                                  | 3 of 23 completed (~13%)                                                                    | Actions API                                      |
| Longest un-concluded run                | 167 min and counting on a `main` push (run 31312937555)                                     | Actions API                                      |
| Job-level `timeout-minutes` in `ci.yml` | **none** — only the e2e _step_ caps at 18 min                                               | `.github/workflows/ci.yml`                       |
| `setup` action cost                     | 4:31 / 4:54 / 4:43 in precheck / check / bench, vs 0:24 in build — same run                 | run 31303508909                                  |
| e2e queue delay                         | shard 1 created 08:42:23, started 08:57:49 — 15 min waiting for a runner                    | run 31303508909                                  |
| e2e pool                                | 8 shards over ~6 ephemeral runners that also serve every check-tier job                     | run 31303508909, `ci-runners/docker-compose.yml` |
| e2e specs off in CI                     | 11 excluded in `wdio.ci.conf.ts` + 3 `describeSkipInCi` = ~7% of 184 specs, none dated      | `wdio.ci.conf.ts`, `tests/e2e/`                  |
| Persisted CI history                    | none                                                                                        | repo-wide                                        |

Two of these deserve calling out because they are not tuning problems.

**No job in `ci.yml` sets `timeout-minutes`.** GitHub's default is 360 minutes. On an
ephemeral self-hosted pool of roughly six runners, one wedged job holds 1/6th of the
fleet's capacity for up to six hours, and every PR behind it queues. The 167-minute run
above is that failure mode in progress. The e2e step is capped; nothing else is.

**Quarantine has no expiry.** Fourteen e2e specs are off in CI. Some entries name a real
cause (`context-wheel` OOM-crashes the runner); others say "flaky on the CI runner" with
no issue, no date, and no way to learn whether the underlying problem was fixed six weeks
ago. This is the part of the suite that decays silently: a green `CI Passed` means less
each month, and nobody finds out.

## Part 1 — CI

Ordered by value over effort. C1 is a prerequisite for arguing about C4–C5 with data
rather than one sampled run.

### C1 — Persist a run record, and write a job summary

**Today.** Nothing measures CI. Durations, queue delays, dependency-cache hit rates, shard
outcomes and oracle decisions exist only inside the Actions UI, where they age out and
cannot be aggregated. `ci.yml` writes one step summary.

**Change.** Two pieces, both cheap:

1. Every job writes to `$GITHUB_STEP_SUMMARY` — the oracle's mode and chosen spec count,
   which dependency source the setup action hit (`baked` / `deps-cache` / `network`), each
   shard's outcome and duration. Free, appears on the run page, and turns "why was this 54
   minutes" into something readable without the API.
2. A final `ci-record` job (`if: always()`, after `ci-passed`) appends one JSON line per
   run to an orphan `ci-metrics` branch: run id, event, base ref, conclusion, oracle mode,
   per-job duration and queue delay, setup source, shard results, and the head SHA. Append
   to a branch rather than an artifact so the history outlives the 90-day retention and
   any agent can read it with `git show`.

**Why this first.** It is the input to flake detection (C2), it settles whether setup
really costs five minutes on most runs or only when a host is cold (C4), and it is the
same observation stream the dark-factory orchestrator needs (P2) — built once, on the CI
side, where it is a twenty-line job instead of a polling service.

### C2 — Make quarantine dated, owned, and self-expiring

**Today.** `wdio.ci.conf.ts` holds a hand-maintained `ciExclude` array and three specs use
`describeSkipInCi`. Entries never expire. Nothing re-checks them.

**Change.** Replace the array with a typed ledger — `{ spec, reason, issue, until }` — and
add three rules:

- `check:quarantine` fails when an entry is past its `until` date or has no issue link. A
  quarantine is a dated loan, not a deletion.
- The nightly full run executes the quarantined specs in a **non-blocking** job. If a spec
  passes ten nights running, the job annotates the run asking for its release. That is how
  you find out the OOM was fixed by an unrelated memory change.
- With C1's record in place, derive flake candidates instead of guessing: a check that
  went fail→pass on the **same head SHA** is a flake by definition, and the record already
  stores head SHAs.

**Why.** ~7% of the e2e suite is dark with no path back to the light. At fleet scale this
is worse than it looks: each quarantined spec is a class of regression that no agent's PR
can be blocked by, so agents will keep reintroducing it and nobody will know.

### C3 — Cap every job

**Change.** Add `timeout-minutes` to every job in `ci.yml` sized to observed p99 plus
headroom — roughly 15 for `precheck`, 20 for `check`, 10 for `build`, 25 for an `e2e`
shard, 5 for `ci-passed`. One line each.

**Why.** On a fixed ephemeral pool, an uncapped job is a capacity leak, and the symptom
(everyone's PR is slow today) is far from the cause (one wedged job three hours ago). This
is the cheapest item in the plan and the only one that is unambiguously a bug.

### C4 — Stop paying for setup once per stage

**Today.** The pipeline is a serial chain — `precheck` → `check`/`build`/`bench` → `e2e` →
`ci-passed` — and every stage re-runs `.github/actions/setup`. On the sampled run that was
4:31, 4:54 and 4:43 in three jobs against 0:24 in a fourth. The bimodality is the design
working as documented: the `deps-cache` volume is host-local, runners are ephemeral, so
the first job to land on a cold host pays the network restore and later jobs on that host
do not. The cost is that the _critical path_ keeps hitting cold hosts, serially.

**Change.** Two options, not exclusive:

- **Prime the fleet.** A `push`-triggered workflow on `package-lock.json` changes that
  fans one trivial job out across the pool purely to populate every host's `deps-cache`
  for the new lockfile hash. It converts "every stage of the next N runs may pay the
  restore" into "one cheap run pays it once per host."
- **Shorten the chain.** `build` does not need `precheck`'s lint result to be correct — it
  needs it to be _worth running_. Letting `build` start in parallel with `precheck` and
  relying on `cancel-in-progress` plus the aggregate gate removes one full setup from the
  critical path, at the cost of some wasted builds on lint failures. C1's record tells you
  the real ratio.

### C5 — Size the e2e fan-out to the pool, not to a constant

**Today.** Eight shards, always, chosen (per the comment) to stay under the memory ceiling.
The pool is roughly six ephemeral runners which also serve every check-tier job, so a full
run asks for ~15 job slots from ~6. The sampled shard 1 waited 15 minutes to start; the
job's own 18-minute cap does not cover queue time, so a saturated fleet inflates
wall-clock invisibly.

**Change.** `precheck` already computes `e2e_shards` dynamically — give it the pool size.
Read the org runner count (or a `E2E_MAX_CONCURRENCY` variable, which needs no PAT, matching
the `CHECKS_RUNNER` pattern already in use) and emit `min(8, idleRunners)` shards. Eight
shards over six runners is strictly worse than six over six: same total work, one extra
serialised wave, plus per-shard setup and a 590 MB artifact download paid an extra time.

The autoscale answer already exists — `scripts/burst-runners.mts` provisions cloud hosts
into the same compose fleet — but it is manual. A queue-depth-triggered burst (scheduled
job reads the Actions queue, scales up, TTL reaps) is the version that helps at fleet
scale.

### C6 — Split `ci.yml` so an agent can read it

**Today.** 111 KB, 1,984 lines, one file. Its comments are genuinely excellent and are the
main reason the design is recoverable — that is not the problem.

**Change.** Decompose into `ci.yml` (orchestration and gating) plus `_checks.yml`,
`_e2e.yml` and `_bench.yml` called via `workflow_call`, the pattern `pages.yml` already
uses. Keep `ci-passed` and every trust guard in the caller so the security boundary stays
in one readable place.

**Why this matters more with agents than with people.** A person edits one region of a big
file. An agent asked to change CI reads the file — 111 KB of a context window before it
has done anything, on every such task, which is both slow and a real source of unrelated
collateral edits. Reusable workflows are the platform's own answer and cost nothing.

### Also worth knowing

- **Merge queue.** The `ci.yml` header correctly notes `merge_group` needs Enterprise
  Cloud for private repos. The promotion flow is a good stand-in. Worth re-checking the
  moment the repo goes public — the code is already Apache-2.0 and the site links it — as
  it is free on public repos and would replace the promotion batch with real bisection.
- **Annotations over log-diving.** Seven `::error`/`::warning` calls in `ci.yml`. Failures
  that carry a file and line (typecheck, lint, failed assertions) can surface as inline
  annotations on the PR diff. For an agent reading a failure, an annotation is structured
  and short; a log tail is neither.

## Part 2 — Product

The app's own audit ([`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md))
already names most of this. What changed since it was written is that its two hardest
blockers landed: `src/main/services/supervisor/` has a real task supervisor, and
`src/main/services/headless-agent-host.ts` exists — that plan's audit table still marks
headless invocation ❌, which is now stale. The gap is smaller than the document says.

### P1 — Ship the activity view

**Today.** `mission-control.md` is Proposed. `agent-tasks.ts` shows only the active
thread's runs (`scopeId`, `MAX_TASKS = 60`). The projects pane has an attention bell per
project and per thread — real, but it requires the app to be open at the right pane. There
is no one place that answers "what are all my agents doing."

**Change.** The panel that plan already specifies: every thread in the workspace, grouped
`NEEDS YOU` / `WORKING` / `DONE`, with last-output age so a wedged run is distinguishable
from a busy one. Nothing new needs inventing; it needs building.

**Why it is the highest-value product item.** With ~25 open PRs and threads spanning days,
the scarce resource is attention, not tokens. Every other item here is a way of putting
something _into_ this view.

### P2 — Give the dark-factory sensor a consumer

**Today.** `dark-factory-sensor.ts` is a registered, adaptive, jittered poll source
(60s pending / 5min failure / 15min idle) behind a default-off pack — with nothing
consuming its events.

**Change.** The two smallest pieces from that plan, in order: the **fleet registry**
(which PRs are ours — the agent-PR link store already keys `owner/repo#number`, plus
head-prefix detection for `claude/`, `codex/`, `copse/`) and the **check-run history
store**. Stop there and ship read-only: the PR pane gains live CI state and a "changed
while you were away" list. No actuators, no autonomy setting, no reruns. That is a week of
work that makes the rest optional rather than a prerequisite.

If C1 lands first, some of this is a read of the `ci-metrics` branch rather than a poller,
which is cheaper and has no rate-limit exposure.

### P3 — Make CI failures shared memory

**Today.** `ci-investigator-service.ts` is on-demand and in-turn only: it can only run
inside a live chat turn. Its findings go into that transcript. The next agent to hit the
same failure starts from zero.

**Change.** Persist investigator conclusions as knowledge-store notes keyed by check name
plus a log signature, and read them **before** investigating. Then a known flake is
answered in one lookup instead of a full diagnostic run, and a failure seen on three PRs
at once is recognised as one incident rather than three.

**Why this is the "team" item.** It is the difference between three engineers who talk and
three who each debug the same broken build in silence. Everything else in Part 2 is
plumbing; this is the one that changes the economics.

### P4 — Make review a role, not a step

**Today.** Agents author, the same human merges. There is no reviewer.

**Change.** A review lane in the PR pane: fleet PRs ranked by what actually needs a human
(diff size, files touched outside the stated scope, CI red, age), with a per-PR review run
that reads only the diff and reports. Not auto-approval — the ranking is the product. When
25 PRs are open, choosing which three to read carefully _is_ the reviewing.

### P5 — Batch the pushes

**Today.** ~23% of CI runs are cancelled by supersession. That is the concurrency group
doing its job, but the cancelled runs still occupied ephemeral runners — up to 13 minutes
in the sample — while other PRs queued.

**Change.** This is a product lever, not a CI one: hold an agent's pushes until its turn
settles, or debounce them, so one turn produces one CI run instead of three. Cheapest
version is guidance in `AGENTS.md`; the durable version is the push path itself
coalescing.

### P6 — Notify outside the window

**Today.** `user-alerts-electron.ts` does have `Notification`, dock bounce and frame flash,
gated on the window not being visible. Good foundation, thread-scoped.

**Change.** Extend it to fleet events once P2 exists — a PR you own went red, a systemic
incident opened, a long-running thread stopped making progress. The rule that matters is
that only exceptions page: routine monitoring stays deterministic and silent, which is the
same principle the dark-factory plan is built on.

## What I would do first

| Order | Item                                    | Effort  | Unlocks                                       |
| ----- | --------------------------------------- | ------- | --------------------------------------------- |
| 1     | C3 job timeouts                         | minutes | stops the capacity leak                       |
| 2     | C1 run record + job summaries           | ~a day  | C2, C4, C5 arguments; P2's observation stream |
| 3     | C2 dated quarantine                     | ~a day  | trust in `CI Passed`                          |
| 4     | P1 activity view                        | ~a week | every other product item has somewhere to go  |
| 5     | C5 pool-sized shards, C4 fleet priming  | ~a day  | wall-clock, once C1 says which one to do      |
| 6     | P2 fleet registry + history (read-only) | ~a week | P3, P4, P6                                    |
| 7     | P3 shared CI memory                     | ~a week | stops N agents re-debugging one failure       |

C6 and C3 are the only items that can land without discussion. Everything below the line
in Part 2 should wait for P1, because a fleet capability with nowhere to surface is how
the dark-factory sensor ended up shipped, gated, and unconsumed.
