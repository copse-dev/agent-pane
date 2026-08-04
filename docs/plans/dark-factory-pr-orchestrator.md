# Dark-factory PR orchestrator

Status: **active (sensor foundation)** — the experimental `copse.dark-factory` pack
gates one supervisor-registered adaptive fleet-poll event source and is default-off.
Fleet discovery, GitHub observations, history, incidents, and actuators remain proposed.

Related design lineage: [#690](https://github.com/copse-dev/agent-pane/issues/690)
(copse-CLI fleet-manager parity — the _actions_ layer this consumes),
[#873](https://github.com/copse-dev/agent-pane/issues/873) (per-PR guarded ship loop —
the _station_ this supervises), [#558](https://github.com/copse-dev/agent-pane/issues/558)
/ [`docs/plans/long-horizon-tasks.md`](./long-horizon-tasks.md) (grind-until-done within
a PR), [`docs/plans/knowledge-store.md`](./knowledge-store.md) (durable findings).
The broader product audit and non-PR workflows live in
[`background-agents-capability-map.md`](background-agents-capability-map.md); this plan
is the PR/CI nurse, not the generic background-agent or campaign control plane.

## What this is

A single, always-on **orchestrator** in the main process that supervises the whole fleet
of PRs we know were created by Copse or this user — across agent runs, across sessions,
across days — the way a _dark factory_ is supervised: routine monitoring is deterministic
code running unattended, model-driven agents are dispatched only when something breaks,
and a human is paged only on exception.

The problem it solves is **long-time-horizon blindness**. Today each agent run
fire-and-forgets its own PR: nothing watches after the turn ends, CI state in the PR pane
goes stale until a manual refresh, and nothing correlates failures _across_ PRs. When a
CI gate flakes or an outage hits, every open agent PR goes red at once, and each future
agent run independently rediscovers (or worse, independently "fixes") the same
plant-level problem — see PR #954, where a one-off automation diagnosed a
concurrency-superseded cancel as a red `CI Passed` gate: exactly the class of incident
this orchestrator exists to catch, classify once, and handle once.

Two roles, per the request:

1. **Nurse** — keep every fleet PR moving: notice stuck/red/stale PRs, rerun known
   flakes, keep a live fleet-health picture the user can glance at after being away.
2. **Triage authority** — agent runs consult the orchestrator instead of each grinding
   alone: "is this failure mine, or is there an ongoing flake/outage?" When the answer
   is plant-level, the orchestrator suppresses duplicate per-PR investigation and
   dispatches **one** handler agent for the incident.

## Current state (audit)

What exists to build on, and what is net-new:

| Piece                                | Where                                                                                                                | Status                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Swappable GitHub backend (`PrRef`)   | `src/main/services/github/backend/backend.ts` (cli / api / mock)                                                     | ✅ reads (PR lists, details, checks rollup) + Wave-1 writes (rerun failed, approve, ready, auto-merge) |
| Cross-repo "my open PRs"             | `listMyOpenPrs` (`gh search prs --author=@me` / search API)                                                          | ✅ exists, used lazily by PR pane                                                                      |
| Agent-run ↔ PR ↔ thread link store   | `src/main/services/remote/remote-agent-link-store.ts`, thread store (`listAgentPrLinks`, `lookupThreadByPrUrl`)      | ✅ per-project reverse index (`owner/repo#number`), backs the PR-pane 🤖 badge                         |
| Per-PR CI rollup                     | `getPrChecksState` → `pending/success/failure/no_checks`; `github-ci-service.ts` (`getCiStatus`, `getCiFailureLogs`) | ✅ point-in-time only; per-check granularity available via `statusCheckRollup` / check-runs API        |
| CI investigator subagent             | `ci-investigator-service.ts` + `investigate-ci-tool.ts` (read-only tool set, local-model routed)                     | ✅ but **on-demand only**, callable only inside a live chat turn (`activeContext` seam)                |
| Follow-up suggestions on PR signals  | `pr-context-service.ts` → `follow-up-service.ts` ("Debug CI" chip)                                                   | ✅ turn-triggered, passive                                                                             |
| PR pane                              | `src/renderer/views/pr-pane.ts`                                                                                      | ✅ event-driven refresh, **no polling**; per-row CI dot from an in-memory session cache                |
| Knowledge store (typed OKF notes)    | `src/main/services/storage/knowledge-store.ts`                                                                       | ✅ new note types need no store change                                                                 |
| Scheduler / background poller        | `src/main/services/supervisor/dark-factory-sensor.ts`                                                                | ⚠️ adaptive, feature-gated event source exists; no fleet/GitHub observation consumer yet               |
| Headless agent invocation            | —                                                                                                                    | ❌ `runAgent` requires an IPC-driven chat turn; subagent runners only work inside one                  |
| Check-run history / cross-PR memory  | —                                                                                                                    | ❌ all CI reads are stateless                                                                          |
| Flake/outage detection               | —                                                                                                                    | ❌ nothing correlates failures across PRs or over time                                                 |
| GitHub rate-limit / backoff handling | —                                                                                                                    | ❌ neither backend inspects rate-limit headers or uses conditional requests                            |
| OS/toast notifications               | —                                                                                                                    | ❌ nearest analogue is the projects-pane attention indicator                                           |
| Durable background task schema       | `src/shared/supervisor/`, `schemas/copse-supervisor-task.schema.json`                                                | 🟡 P1 schema/reconcile foundation only; no main-process supervisor service or timers                   |
| Project cron automations             | `src/main/services/automations/`, `copse.automations` pack                                                           | ✅ app-open prototype; not headless and not the orchestrator scheduler                                 |

## Background-agents.com comparison

Ona's [Background Agents guide](https://background-agents.com/) adds a useful test for
this proposal: isolated execution, runtime governance, internal connectivity, triggers,
and fleet coordination are all required before "self-driving codebase" is an honest
claim. This plan covers only PR/CI sensing and nursing. It consumes the supervisor,
runtime-security, cloud/detached-worker, and campaign foundations mapped in the
[capability audit](background-agents-capability-map.md).

Of the guide's seven starter workflows, CI failure triage is directly owned here and
stale/merge-conflicted PR nursing is adjacent O6 scope. Code review, CVE remediation,
coverage expansion, standards enforcement, and release-note drafting are separate
workflow consumers. They must not turn this service into a generic prompt scheduler.

## Architecture

Three layers, strictly separated so the expensive/risky layer is entered as rarely as
possible — this separation _is_ the "dark factory" property:

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. SENSORS (deterministic, cheap, always-on)                     │
│    fleet registry · adaptive poller · check-run history store    │
├──────────────────────────────────────────────────────────────────┤
│ 2. CONTROL (deterministic, pure, unit-testable)                  │
│    incident derivation (flake / systemic / pr-local / stale)     │
│    policy engine: rerun caps, dedupe, suppression, routing       │
├──────────────────────────────────────────────────────────────────┤
│ 3. ACTUATORS (bounded, budgeted, mostly agent-driven)            │
│    safe GitHub actions · headless diagnosis run · repair         │
│    dispatch · route-to-owning-thread · notify human              │
└──────────────────────────────────────────────────────────────────┘
```

New service: `src/main/services/github/pr-orchestrator/` —
`orchestrator-service.ts` (singleton lifecycle, owned by main like the MCP service),
`fleet-registry.ts`, `ci-history-store.ts`, `incident-engine.ts` (pure),
`orchestrator-policy.ts` (pure), plus IPC handlers and renderer surface.

### 1. Sensors

**Fleet registry — which PRs are "ours".** A PR joins the fleet from any of:

- the **agent-PR link store** (authoritative: PRs our launched agents opened, already
  keyed `owner/repo#number` with the owning thread);
- **`listMyOpenPrs` ∩ agent-branch detection** — adopt copse-CLI's detection (#690 Q5):
  head-branch prefixes (observed in this repo: `claude/`, `cursor/`, `codex/`,
  `copse/`, `jkt/auto/`), agent labels, and commit co-author scan. The prefix list is a
  setting with those defaults;
- **manual pin/unpin** from the PR pane row (escape hatch both directions).

Membership is persisted per project (`fleet.json` beside the thread store) with
provenance (`link | detected | pinned`) so a detection-rule change never silently drops
a PR that an agent verifiably owns. Merged/closed PRs leave the active fleet but their
history is retained for the correlation window.

**Adaptive poller.** One scheduler pass fetches the whole fleet — never per-PR timers:

- Cadence per PR by state: checks `pending` → ~60s; open+red → ~5 min; open+green idle →
  ~15 min; and an hourly discovery sweep (`listMyOpenPrs` + workspace PRs) to catch PRs
  created outside the app. Jittered; paused when the app knows it is offline.
- **Rate-limit discipline is a blocker, not a nice-to-have** (audit: neither backend has
  any). The API backend gains ETag/conditional requests and `X-RateLimit-*` /
  `Retry-After` inspection with global backoff; the CLI backend gets a coarse
  min-interval. Backend interface grows `listCheckRuns(ref | headSha)` returning
  per-check `{name, conclusion, startedAt, completedAt, runId, headSha}` — the rollup
  alone cannot support flake detection.

**Check-run history store.** Append-only JSONL under
`~/.copse/ci-history/<workspace>/observations.jsonl`: one line per observed check-run
transition `(repo, prNumber, headSha, checkName, runId, attempt, conclusion, observedAt)`.
This is machine telemetry, deliberately **not** knowledge-store notes (high-volume,
unauthored); retention-window compaction (default 14 days) on startup. It is the input
to correlation and the source of "what changed while you were away".

### 2. Control — incident derivation

`incident-engine.ts` is a pure function `(history, fleet, mainBranchState) → incidents`
so the whole classification matrix is unit-testable without GitHub. Incident classes:

| Class           | Signal (defaults, all tunable)                                                                                      | Default handling                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `flake_suspect` | Same check: fail→pass on the **same head SHA** (rerun recovered), or intermittent across ≥2 PRs with no common diff | Auto-rerun on next occurrence (capped); count it                   |
| `systemic`      | Same check failing on ≥3 distinct fleet PRs within the window, **or** failing on `main` tip                         | Open one incident; suppress per-PR investigation; diagnose once    |
| `infra_outage`  | Runs not starting / runner-offline / cancellations across PRs; queue times exploding                                | Observe + notify; nothing to fix in-repo; auto-resolve on recovery |
| `pr_local`      | Failure unique to one PR (not matching any open systemic/flake pattern)                                             | Route to the PR's owning thread (#873 ship loop)                   |
| `stale`         | Fleet PR open ≥7d without activity, or checks green + unmerged ≥N days, or merge-conflict transition                | Surface in fleet view; suggest action                              |

Incidents themselves are **knowledge-store notes** (new type `CiIncident`, status
lifecycle `open → mitigating → resolved`), because they are exactly what that store is
for: durable, per-project, browsable, agent-readable findings. The note body accumulates
the evidence (matching observations, diagnosis summaries, actions taken). A resolved
flake incident leaves behind a **flake-pattern note** (`CiFlakePattern`: check name +
optional log-signature regex) that the policy engine matches against future failures —
institutional memory, so known flakes are auto-rerun without re-diagnosis.

**Escalation rule (don't nurse symptoms forever):** when a flake pattern's occurrence
count crosses a threshold (default 5 in the window), the orchestrator promotes it to a
`systemic` incident whose goal is _fix the flaky test/gate_, not rerun it again. A dark
factory repairs the machine; it doesn't station a worker to kick it.

### 3. Actuators — the handling ladder

Ordered by autonomy; each rung is individually capped and everything is journaled to the
incident note:

1. **Record + surface** (always): fleet view, incident notes, attention indicator.
2. **Safe GitHub actions** (deterministic): `rerunFailedRuns` for flake-pattern matches —
   capped at 2 reruns per check per head SHA and a per-day fleet total; update-branch
   (once the #690 Wave-1 `update-main` action exists). Never approve, never merge, never
   mark-ready, never push — those stay human/approval-gated regardless of autonomy level.
3. **Route to owner** (deterministic): for `pr_local`, enqueue a context message into the
   PR's owning thread via the link store + pending-message queue ("check X failed on your
   PR #N; fleet says it is not systemic; logs attached") — it drains under the existing
   auto-continuation budget rules, so the per-PR loop (#873) picks it up with fleet
   context instead of blind.
4. **Headless diagnosis** (one agent, bounded): run the existing CI investigator subagent
   against the incident — read-only tool set, local-model routing, `maxSteps` bounded —
   and write its findings into the incident note. One live diagnosis per incident, ever,
   until its evidence set changes.
5. **Repair dispatch** (approval-gated by default): materialize a fix as a normal unit of
   work — a pre-filled thread (the roadmap pane's "Start thread" pattern: composer filled,
   user sends) or, at higher autonomy, a managed-agent launch that opens a normal PR
   through normal approvals. The orchestrator never lands repairs itself.
6. **Page the human**: OS notification + attention badge for new `systemic`/`infra_outage`
   incidents and for any rung the policy won't take autonomously.

**Autonomy is a setting, not a redesign:** `orchestratorAutonomy: 'observe' | 'nurse' |
'dispatch'` = rungs 1–3 / 1–4 / 1–5-with-per-incident-approval. Default on enable:
`nurse`. There is no fully-unattended repair mode in v1.

### Agent runs consult the orchestrator

The other half of "my agent runs go to a single orchestrator": in-turn agents get a
read-only tool, `ci_fleet_status` (registered when the flag is on), answering "current
incidents; is check X on PR #N implicated; recommended action". Plus steering: when a
turn's PR context (`pr-context-service.ts`) shows `hasCiFailures` **and** an open
incident matches, the turn-start steering block says so — preventing the expensive
failure mode where five parallel agent runs each burn a context window independently
investigating the same broken gate. The CI investigator's system prompt gains the same
check ("consult fleet incidents before deep-diving").

## Decisions log

Settled here; changing one means updating this doc, not silently diverging.

1. **One orchestrator per app instance, in the main process.** Not per-thread, not a
   subagent of any chat turn. It owns the only PR/CI polling loop in the app; the PR
   pane becomes a _consumer_ of orchestrator state pushed over IPC (its lazy per-row
   fetch remains only as the flag-off fallback).
2. **Deterministic-first ("dark factory").** Sensors and control are plain code — pure,
   unit-testable, no model calls. A model runs only at rungs 4–5, on a classified
   incident, bounded and deduplicated. Routine supervision must cost ~zero tokens.
3. **Fleet membership is provenance-tracked union** of link-store PRs, detected
   agent-branch PRs (`claude/`, `cursor/`, `codex/`, `copse/`, `jkt/auto/` defaults),
   and manual pins — with unpin as the escape hatch. Detection heuristics may evolve;
   link-store membership is never overridden by them.
4. **Poll, don't listen.** A desktop app with no server gets no webhooks; polling with
   adaptive cadence, jitter, conditional requests, and rate-limit backoff is the model.
   Backoff/ETag work in the API backend is a prerequisite, not an optimization.
5. **Telemetry and findings live in different stores.** Check-run observations →
   append-only JSONL with retention compaction (`~/.copse/ci-history/<workspace>/`).
   Incidents and flake patterns → knowledge-store note types (`CiIncident`,
   `CiFlakePattern`), giving browse/search/status lifecycle and agent readability for
   free. No third bespoke store.
6. **Incident classification is a pure function** over (history, fleet, main-branch
   state). The classification matrix above ships with unit tests per cell before any
   actuator exists.
7. **Suppression is a first-class output.** An open `systemic` incident actively stops
   duplicate work: per-PR loops are steered off the failure, `investigate_ci` consults
   incidents first, and the orchestrator runs at most one diagnosis per incident.
8. **Headless agent runs are real threads.** Rungs 4–5 execute in orchestrator-created
   threads in the normal thread store (titled, e.g., `CI incident: <check> systemic`),
   via a new `runHeadlessTurn` seam extracted from `agent-service.ts` — so the spine,
   usage accounting, tool approvals, and the chat UI audit trail all come free, and the
   user can open the thread and take over at any point. No invisible side-channel runs.
9. **The orchestrator never merges, approves, force-pushes, or lands repairs.** Its
   write surface to GitHub is rung 2 (rerun / update-branch) only. Repairs become
   ordinary PRs through ordinary approval flows. (Interacts with #690 Q3 tiered
   approvals; whatever lands there governs rung 2 grants too.)
10. **Hard budgets on every actuator**, counted per day and shown in the fleet view:
    reruns (per check-SHA and fleet-wide), diagnoses, dispatches, and a token budget for
    rungs 4–5. Exhaustion degrades to rung 1 + notification — never silent, never
    unbounded.
11. **Fully inert while off.** Flag off ⇒ no scheduler starts, no store is created, no
    tool is registered, PR pane behavior unchanged — the `ciInvestigatorEnabled`
    pattern.
12. **Workspace-scoped v1** (confirmed by owner, July 2026). Fleet = active project's
    repo + its link-store PRs (`author:@me` cross-repo rows are listed but
    observe-only). The copse-CLI-style multi-repo `repos[]` fleet is explicitly
    deferred to the #690 Q2 decision.
13. **App-open-only supervision in v1** (confirmed by owner, July 2026). The
    orchestrator runs only while the Electron app is open; overnight gaps are covered
    by the "while you were away" delta computed from the ci-history store on resume,
    not by a daemon. No headless/detached host is designed for in v1 — if the
    cloud-workspaces direction (PR #959) lands later, sensors/control moving to a
    headless home is a new plan, not a hidden requirement here.
14. **No cross-supervisor locking in v1** (confirmed by owner, July 2026). copse-CLI
    and Cursor automations may act on the same repos concurrently; rerun caps and
    one-diagnosis-per-incident make double-acting wasteful rather than harmful, which
    is accepted. Revisit (PR-label lease) only if double-dispatch is observed in
    practice.
15. **`nurse` is the confirmed default autonomy** (owner, July 2026): capped reruns,
    owner-thread routing, and headless diagnosis run unattended; repair dispatch
    (rung 5) always requires per-incident approval in v1 — no trust-period
    hands-free mode.
16. **Measure the system outcome and graduate autonomy progressively.** O0 records a
    baseline before O1 changes behavior. Every incident/action links trigger time,
    classification, first result, accepted resolution, human correction/rejection,
    tokens/compute, and external actions. Rollout is `observe → nurse → dispatch` per
    workflow/policy, with an explicit rollback to observe. PR count is not a success
    metric; trigger-to-accepted-resolution, queue age/lead time, correction/regression,
    and human interventions per completed incident are.
17. **Campaigns are upstream, PR nursing is downstream.** Cross-repo remediation (for
    example one CVE over 100 repos) is a supervisor campaign with one isolated child per
    target. Its resulting PRs join this fleet and use this incident/nursing policy. The
    orchestrator does not discover an organization and manufacture arbitrary campaigns.

## Phases

Each phase is independently shippable and useful; later phases are inert without the
earlier ones.

- **O0 — baseline + observe policy.** Define the selected fleet, current CI-failure and
  stale-PR turnaround, human interventions/corrections, rate-limit budget, and the
  event schema linking sensor observation → incident → action → accepted resolution.
  Ship deterministic replay fixtures before actuators. Acceptance: a fixture/report can
  reproduce baseline and observe-only classification without a GitHub write or model
  call.
- **O1 — sensors + fleet view (observe-only).** Flag + settings schema; fleet registry;
  backend `listCheckRuns` + rate-limit/backoff/ETag work; adaptive poller; ci-history
  store; IPC push; PR-pane fleet strip (fleet counts, per-PR freshness, "while you were
  away" delta). Acceptance: leave the app running during a red-CI afternoon; the pane
  shows live truth with zero manual refreshes and API usage stays within documented
  bounds.
- **O2 — control.** `incident-engine.ts` + policy engine with the full classification
  matrix under unit test; `CiIncident`/`CiFlakePattern` note types; incident rows in the
  fleet view; attention indicator + OS notification on `systemic`/`infra_outage`.
- **O3 — deterministic actuators + consultation.** Capped auto-rerun for flake matches;
  `pr_local` routing into owning threads via the pending-message queue;
  `ci_fleet_status` tool + turn-start steering integration. Acceptance: a seeded flake
  (mock backend) is rerun at most twice and journaled; a systemic incident steers a
  concurrent chat turn away from re-investigating.
- **O4 — headless diagnosis.** `runHeadlessTurn` seam; orchestrator-owned incident
  threads running the CI investigator; one-diagnosis-per-incident dedupe; findings
  folded into the incident note.
- **O5 — repair dispatch.** Pre-filled fix threads from an incident; per-incident
  approval flow; flake-promotion ("fix the flaky test") path; optionally managed-agent
  dispatch behind the same approval.
- **O6 — widen.** Cross-repo fleet (pending #690 Q2), stale/merge-conflicted PR nursing
  actions (update-branch; mechanical conflict handling only), richer notification
  routing, and campaign-result ingestion from the supervisor. Campaign creation/fan-out
  remains owned by `background-supervisor.md` P6.

## Known implementation traps

- **`runAgent` is turn-shaped.** It assumes an IPC submit, an `AgentHost` sink, and
  populates per-tool-call runner contexts (`activeContext`) that subagent runners
  require. The `runHeadlessTurn` extraction (O4) must preserve hook dispatch, PII
  redaction, and the auto-continuation budget — do not clone a parallel loop.
- **No rate-limit handling exists anywhere** (audit §10). Shipping O1's poller without
  backoff will get users throttled; `gh` CLI hides limits until it fails. Treat the
  backend hardening as part of O1, not a fast-follow.
- **`getPrChecksState` degrades to `no_checks` on API errors** (api backend) — the
  poller must distinguish "no checks" from "fetch failed" or outages will read as green
  fleets. Sensor reads need an explicit error channel.
- **gh auth precedence (#516).** `runGh` deliberately prefers `gh`'s own config-dir auth
  over env tokens; the poller must reuse `runGh`/`resolveGitHubApiToken` rather than its
  own token plumbing.
- **Thread-store full-save round-tripping**: orchestrator-created threads and queued
  routed messages ride the same spine rules as hooks (see hooks plan decision 6) —
  anything appended must survive `writeThread` regeneration.
- **Mock backend is the e2e substrate.** `COPSE_PANEL_MOCK_GH=1` + `MockPrState` already
  model per-PR failed runs; extend it with scripted check-run sequences so flake and
  systemic scenarios are e2e-testable without GitHub.
- **PR #954-class ambiguity**: concurrency-superseded cancellations look like failures.
  `normalizeCheckBucket` treats them as bad; the incident engine needs the
  cancelled-but-superseded carve-out or every stack rebase reads as an outage.

## Open questions

1. **Where does the user _set_ per-check policy** (e.g. "never auto-rerun the e2e
   check") — settings JSON, the fleet view, or editable `CiFlakePattern` notes?
2. **Notification channel** beyond OS toast — the follow-up chips and attention badge
   exist; is a digest ("fleet summary since you left") a chat message, a pane, or both?
3. **Fleet identity beyond v1's workspace scope** — post-O6, is a cross-repo fleet
   per-GitHub-user with project views, or a copse-CLI-style `repos[]` config? (Bound to
   #690 Q2; the v1 answer is decisions 12–13.)

_Resolved in review (July 2026):_ fleet scope (→ decision 12), orchestrator host /
uptime (→ decision 13), cross-supervisor coordination (→ decision 14), default
autonomy (→ decision 15).

## Related

- [#690](https://github.com/copse-dev/agent-pane/issues/690) — PR lifecycle actions
  (Wave 1 shipped: rerun/approve/ready/auto-merge), fleet-manager gap analysis, open
  questions Q2/Q3/Q5 that this plan binds to.
- [#873](https://github.com/copse-dev/agent-pane/issues/873) — per-PR guarded ship loop;
  rung-3 routing is its fleet-aware entry point.
- [`docs/plans/hooks-and-feature-packs.md`](./hooks-and-feature-packs.md) — pending-message
  queue + auto-continuation budget that rung 3 rides; a later extraction of this feature
  as a pack should follow that plan.
- [`docs/plans/knowledge-store.md`](./knowledge-store.md) — `CiIncident` /
  `CiFlakePattern` note types.
- [`docs/plans/long-horizon-tasks.md`](./long-horizon-tasks.md) — "CI integration /
  grind until green" follow-up that rungs 3–5 realize.
- [`background-agents-capability-map.md`](background-agents-capability-map.md) — honest
  current-capability matrix, other starter workflows, detached execution, campaigns,
  and production feedback requirements.
- `src/main/services/remote/remote-agent-link-store.ts` — agent-PR provenance.
- PR #954 — the ad-hoc CI-failure-investigation automation this systematizes.
