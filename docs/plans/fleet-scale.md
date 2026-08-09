# Working at fleet scale

**Status: Proposed**, except C3 which landed as
[#1663](https://github.com/copse-dev/agent-pane/pull/1663). This is an audit of what
breaks when one person supervises a fleet of agents rather than writing the code
themselves: what the CI should do differently, what the product should do differently, and
what neither currently lets you look at.

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

**Change.** Add `timeout-minutes` to every job in `ci.yml`. Landed as
[#1663](https://github.com/copse-dev/agent-pane/pull/1663): 30 for `precheck`, 20 for
`autoformat`, 45 each for `check` / `bench` / `e2e`, 30 for `build` and
`commit-screenshots`, 90 for the two model-eval jobs, 15 for `ci-passed` — with a pin in
`scripts/ci-workflow-invariants.test.ts` asserting every job _has_ a cap, so a job added
later fails a unit test instead of being found as a six-hour outage.

Note the sizing rule, because the obvious one is wrong: these are leak-stoppers, not
latency targets. Each is roughly 3–5x observed, since a false red on a slow-but-healthy
run costs more than the leak it prevents. Tighten later against C1's real p99, not against
a guess. Queue time is excluded — Actions starts the clock when a job begins executing —
so the caps do not punish a saturated fleet.

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

### C7 — Make the architectural boundaries enforceable, not just true

**Today.** The repo has several real structural boundaries and enforces them by test,
convention, or hand. The clearest case is the Electron boundary:
`agent-path-electron-surface.test.ts` walks the import graph from three named roots and
proves no runtime Electron import is reachable from them. That is a good test, and what it
guarantees is narrower than it reads — a file _not_ reachable from those roots can take a
runtime Electron dependency freely, and only turns some later, unrelated PR red once
something imports it. The boundary is also invisible while editing: `src/main/services/`
gives no signal about which side of the line a file is on.

Measured across `src/` and `packages/` on 2026-08-09:

| Boundary                                   | State                                                                    | Enforced by           |
| ------------------------------------------ | ------------------------------------------------------------------------ | --------------------- |
| Agent path must not import `electron`      | 18 runtime importers in `src/main`, all legitimately the desktop surface | one test, three roots |
| `renderer` must not import `main`          | **2 violations**, both in `settings-dialog.ts`                           | nothing               |
| `packages/*` must not import `src/`        | clean                                                                    | nothing               |
| `shared` must not import `main`/`renderer` | clean                                                                    | nothing               |
| `renderer` must not import node builtins   | clean                                                                    | nothing               |

The renderer→main row is the one that shows the cost of leaving a boundary unenforced,
because the repo is currently paying it in both directions at once. `agent-tasks.ts`
**respects** the boundary by hand-duplicating `stripTerminalControlSequences`, with a
comment saying it is "kept inline to avoid importing a main-process module into the
renderer bundle" — while `settings-dialog.ts` **violates** it twice, reaching into
`main/services/` for `validateAdvisorPair` and `DEFAULT_ORCHESTRATION_WORKER_MODEL`. One
file pays for the rule in duplicated code; another ignores it; neither is told.

**Change.** Three tiers, in cost order:

1. **Ship the Electron rule** — an eslint `no-restricted-imports` on the bare `electron`
   module with an explicit allow-list, type-only imports still legal. Landed as
   [#1667](https://github.com/copse-dev/agent-pane/pull/1667): 815 of 841 source files come
   under it, zero violations, every allow-list entry load-bearing.
2. **Pin the three clean boundaries.** A rule with no violations costs nothing to add and
   prevents the _first_ one, which is the only cheap moment to prevent it. `packages/*`
   not importing `src/` matters most: it is what keeps the already-extracted
   `@copse/agent` / `@copse/llm` genuinely standalone.
3. **Resolve renderer→main, then pin it.** Both imports are pure (`@shared` + `@copse/llm`
   only), so they are harmless at runtime and merely point the wrong way. The fix is to
   move those two exports into `src/shared`, which is what that tree is for — but
   `advisor-strategy.ts` and `orchestration-strategy.ts` are both under active work, so
   this wants sequencing behind those rather than doing now.

**Why this belongs in a fleet plan.** A convention that lives in a maintainer's head
scales to the people who have talked to that maintainer. Agents have not. They infer the
rule from the code they can see — and what they can see here is one file duplicating a
function to respect a boundary and another importing straight through it. A lint rule is
how you tell every future contributor, human or not, at the moment it matters.

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
already names most of this, and two of its blockers have moved since it was written.

Its audit table marks headless agent invocation ❌ — "`runAgent` requires an IPC-driven
chat turn; subagent runners only work inside one". That is now half-true rather than
true. `src/main/services/headless-agent-host.ts` runs the complete local agent surface
from an explicit `HeadlessAgentProfile` (workspace root, model, settings, API keys,
enabled packs, tool availability, trust posture) with **no renderer and no IPC**. It is
bootstrap only — provider, prompt, tools, permissions and the loop all stay in the same
`runAgent` the renderer drives — and it isolates concurrent runs through async-local
scopes rather than mutating desktop state. Absent interaction handlers resolve
deterministically instead of waiting for UI: approvals deny, `ask_user` returns empty,
staged diffs decline. `src/main/services/supervisor/` likewise now has a real task
supervisor with a durable store.

The honest qualification: **nothing in the main process drives either yet.** The only
non-test caller of `runHeadlessAgent` is `scripts/autonomy-regression-agent.mts`, so the
runtime is exercised by a harness, not by the product. That still changes the estimate —
the remaining work is wiring a consumer to an existing runtime, not building the runtime
— but the plan should not be read as "headless is done".

It changes the estimate by more than the file's location suggests, because the headless
host is **not Electron-minus-the-window — it has no runtime Electron dependency at all**,
and that is held by two mechanisms rather than asserted. A static walk pins zero runtime
Electron imports reachable from the three construction roots, and
`scripts/verify-agent-path-import.mts` goes further: it bundles those roots for plain
Node, runs them in a child process with `Module._load` patched to throw on `electron`, and
_actually constructs_ the registry and system prompt. Not "does not import Electron" —
"builds the real agent under plain Node with Electron poisoned".

Measured, 311 of the 408 non-test files in `src/main` are Electron-free and reachable from
that host; only 18 files in the whole tree import `electron` at runtime. So `src/main` is
~96% portable agent runtime with a thin desktop shell beside it, and the directory name is
the misleading part rather than the placement.

The consequence for everything below: a consumer of this runtime does **not** have to be
the desktop app. A utility process, a worker, a plain Node CLI, or an agent running
_inside a container_ are all reachable without dragging Electron along — which is what
makes S4's "watch this agent" and P2's fleet nurse buildable at all, rather than requiring
a whole second runtime first. What it does not yet have is a package boundary making that
legible; see C7.

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

## Part 3 — Seeing the work

The parts above are about knowing _that_ something is wrong. This part is about being
able to look at it: zooming into a failure, and watching the pixels inside the container
where the work is actually happening. It is the sharpest reading of "CI/CD tools have a
lot of what you want", because this is the problem that ecosystem has spent a decade
solving and this repo has not yet borrowed from.

### Three consumers, three artefacts

The mistake to avoid is treating "see the screen" as one feature. The same pixels serve
three readers who want different things, and conflating them is why nothing gets built:

| Reader                               | Wants                                            | Latency        | Right artefact                        |
| ------------------------------------ | ------------------------------------------------ | -------------- | ------------------------------------- |
| Human triaging a fleet               | which of these is stuck; what is on screen _now_ | live           | a live view, glanceable, low fidelity |
| Human debugging one failure          | the thirty seconds before the assertion          | after the fact | a scrubbable recording + a timeline   |
| Model — investigator or orchestrator | what changed on screen, in tokens                | after the fact | a few visually distinct stills        |

Copse already ships the machinery for the third and has neither of the first two.

### What a failure gives you today

On a failing e2e shard, `wdio.conf.ts`'s `afterTest` writes **one screenshot, the page
source, and the browser console** per failing test, uploaded with 3-day retention. On the
sampled `ci-full` run, six of eight shards failed: six stills for six shards, no video, no
action timeline, no runner state beyond the cgroup snapshot. The image has `xvfb` but no
`x11vnc` and no `ffmpeg`, so nobody can watch a run and nothing records one. And
`reporters: ['spec']` means the e2e tier emits **no structured results at all** — the unit
tier does emit TAP (`unit-tests.tap`), which is uploaded as an artifact and never parsed.

The one place this repo does do it properly is the Terminal-Bench **capsule**: a sealed
archive of a run with `scripts/debug-terminal-bench.mts` to unpack and inspect it. That
pattern is right and exists only for the benchmark harness. Generalising it is cheaper
than inventing something.

### S1 — Record the run, keep the failures

`@wdio/video-reporter` is WebdriverIO's own answer: per-test video, with the option to
retain only failures. The single image change it needs is `ffmpeg`, one apt line next to
`xvfb`. A twelve-second clip of the moments before an assertion answers "did it render
wrong or never render" instantly, which is exactly the class of constrained-runner flake
the current stills fail to explain.

### S2 — A live window into a running shard

The Selenium Grid pattern, unchanged for years: `x11vnc` attaches to the existing `:99`
display and `noVNC` serves it over HTTP (their standalone images expose it on `:7900`).
Xvfb is already there; this is one package and one port. Being able to open a tab and
watch a shard is what makes a stuck run diagnosable in seconds rather than after an
18-minute timeout.

Worth pairing with a **break-glass shell** — a `tmate`/`upterm` step gated behind a
label, giving a shell inside the exact failed container, which is CircleCI's "rerun with
SSH" as a GitHub Action.

### S3 — Structured results, so failures are data

Add a JUnit or Allure reporter to the wdio configs and parse the existing TAP. Two things
fall out that cannot be had any other way: **inline annotations on the PR diff** (an
agent reading a failure gets a file, a line and a message rather than a log tail), and a
**per-test history** — the exact input C1's record and C2's flake detection want. This is
the same stream Buildkite Test Analytics, Trunk and Datadog CI Visibility consume; adopt
the format now whether or not a hosted service is ever bought.

### S4 — Point `video_frames` at the container

This is the product item, and it is the one where Copse is further ahead than it looks.

[`video_frames`](../video-frames.md) exists precisely because no model watches video: it
turns a recording into a small set of **visually distinct stills**, so a screen that never
changed comes back as one image. That is not a nice-to-have here — it is the primitive
that makes fleet oversight affordable. Forty agents each producing twenty minutes of
screen is unwatchable by a human and unaffordable for a model; distinct-frame sampling
makes it both.

[`screen-capture-and-remote-video.md`](screen-capture-and-remote-video.md) is already the
plan for capturing from a machine that is not this one. **A container is that case, and
the easiest instance of it** — easier than an iOS Simulator or an SSH host, because we
build the image and can put the recorder in it.

What that plan defers is the half fleet oversight needs most. It says outright that it
does not attempt "a live pixel feed the model watches", and orders liveness last. That is
right for the model and wrong for the human, and bundling them is why neither exists.
Split them:

- **Liveness is human-facing and needs no decoder.** noVNC or an MJPEG endpoint into an
  `<img>`; nothing in the `video_frames` contract is involved.
- **`video_frames` stays the model's path**, over the finished recording, unchanged.

Then "watch this agent" becomes a real product surface: a live view for any containerised
run (managed remote agents, cloud workspaces, the Docker benchmark adapters), a scrubbable
replay attached to the run afterwards, and `video_frames` over that replay so the CI
investigator and the orchestrator can read what the human just watched. That last link is
what ties this back to P3 — an incident note that carries frames is a far better piece of
institutional memory than one that carries a log tail.

Note the live bug that plan already records and that this depends on: `video_frames`
cannot read any real video on an SSH workspace today, because `readFileBytes` goes through
a 100 KiB-capped exec. Any container path will hit the same ceiling, so its P0 is this
part's P0 too.

## What I would do first

| Order | Item                                               | Effort  | Unlocks                                        |
| ----- | -------------------------------------------------- | ------- | ---------------------------------------------- |
| 1     | C3 job timeouts                                    | minutes | stops the capacity leak                        |
| 2     | C7 tier 1–2 boundary lint rules                    | ~a day  | a convention agents can actually see           |
| 3     | S1 + S2 video reporter, noVNC (`ffmpeg`, `x11vnc`) | ~a day  | a failure you can look at, a run you can watch |
| 4     | C1 run record + job summaries                      | ~a day  | C2, C4, C5 arguments; P2's observation stream  |
| 5     | S3 structured test results                         | ~a day  | annotations, per-test history, C2's input      |
| 6     | C2 dated quarantine                                | ~a day  | trust in `CI Passed`                           |
| 7     | P1 activity view                                   | ~a week | every other product item has somewhere to go   |
| 8     | C5 pool-sized shards, C4 fleet priming             | ~a day  | wall-clock, once C1 says which one to do       |
| 9     | P2 fleet registry + history (read-only)            | ~a week | P3, P4, P6                                     |
| 10    | S4 container capture → `video_frames`              | ~a week | "watch this agent"; frames in incident notes   |
| 11    | P3 shared CI memory                                | ~a week | stops N agents re-debugging one failure        |

C3 ([#1663](https://github.com/copse-dev/agent-pane/pull/1663)), C7 tier 1
([#1667](https://github.com/copse-dev/agent-pane/pull/1667)), C6, S1 and S2 can land
without discussion — S1 and S2 are two packages in `ci-runners/Dockerfile` and a reporter
entry, and they change the debugging experience more per line than anything else here.

Two ordering constraints are worth keeping. Everything below the line in Part 2 should
wait for P1, because a fleet capability with nowhere to surface is how the dark-factory
sensor ended up shipped, gated, and unconsumed. And S4 should wait for S1/S2, because the
product feature is worth building once the capture path is proven somewhere cheap — CI is
the cheapest place to learn what a container recording costs and what it is worth.
