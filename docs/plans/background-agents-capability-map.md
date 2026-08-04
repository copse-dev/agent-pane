# Background agents and self-driving-codebase capability map

**Status: Roadmap map.** This document does not introduce a second orchestrator or
runtime. It audits the background-agent model described by Ona's
[Background Agents guide](https://background-agents.com/) and
[complete text/white paper](https://background-agents.com/llms-full.txt) against Copse
as of 2026-07-30, records what an ordinary developer can use now, and assigns every
material gap to an existing plan.

The source's useful contribution is not a novel agent loop. It is the system boundary:
a background agent is device-independent work in an isolated development environment,
started by an event or schedule, governed at runtime, and observable as part of a
fleet. On that definition, Copse has strong coding-agent and delegated-agent
foundations, one app-open automation prototype, and plans for every primitive. It does
**not** yet provide a Copse-native self-driving codebase.

## Vocabulary that product copy and plans must preserve

| Mode                          | Meaning in Copse                                                                                                  | Available today?        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Interactive agent             | A developer starts a thread and Copse's local loop works while the app owns the turn.                             | Yes                     |
| In-session background process | A live thread starts a child process and can poll or stop it; the process is not a durable agent task.            | Yes                     |
| App-open automation           | A local cron schedule creates and submits a thread while Copse and the relevant renderer are open.                | Experimental            |
| Managed remote agent          | Copse hands a task to a provider-owned remote agent and records the provider task/PR.                             | Yes, provider-dependent |
| Copse background agent        | A durable Copse task reasons and executes after the desktop/renderer disconnects, with scoped identity and audit. | No                      |
| Factory campaign              | One intent fans out across repositories/tasks, tracks aggregate progress, and converges or escalates.             | No                      |

Calling an app-open cron or a shell child process a "background agent" would hide the
two properties users care about most: whether closing the app stops progress and which
runtime actually enforces permissions.

## What a regular developer can do now

Assuming the relevant model/GitHub/remote provider is configured, a developer can:

- run a provider-neutral coding turn with filesystem, search, Git, shell, MCP, browser,
  subagent, review, and approval surfaces;
- give threads separate Git worktrees, preserving a durable thread transcript and
  execution ownership instead of making concurrent agents share one checkout;
- work against a manually configured SSH repository, or delegate a task to a supported
  provider-managed remote agent;
- enable the default-off `copse.automations` pack and create project-scoped five-field
  cron prompts, including a pinned model and **Run now** action; scheduled work still
  needs Copse open and may pause for ordinary approvals;
- enable the default-off long-horizon pack to persist a goal/checklist across sessions;
  it records progress but does not yet self-pace or wake itself;
- inspect owned/open PRs, see point-in-time CI state, use shipped PR actions, and invoke
  the read-only CI investigator during a live turn;
- encode repository context in instructions, skills, hooks, thread references, and
  typed knowledge notes, with local benchmark tooling for agent-quality experiments.

That is already useful **delegated development**. The missing step is organizational
automation: durable invocation, independent compute, fleet control, and a measured
feedback loop.

## Primitive coverage

| Background-agent primitive       | Shipped Copse foundation                                                                                                   | Missing product capability                                                                                                                    | Owning plan                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated, reproducible compute   | Per-thread worktrees; macOS ASRT containment; shipped SSH workspace; provider-managed agents; remote-e2e provisioning core | On-demand Copse runtime, image/toolchain contract, Linux/Windows enforcement parity, teardown/reconcile, and device-independent agent loop    | [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md), [`execution-runtime-security.md`](execution-runtime-security.md)                                                                     |
| Runtime governance               | Pure shell permission policy, approval gate, hooks, thread spine, provider handoff record                                  | Execution-scoped non-human identity, least-privilege credentials, complete canonical effect audit, leases/idempotency, and brokered egress    | [`execution-runtime-security.md`](execution-runtime-security.md), [`background-supervisor.md`](background-supervisor.md)                                                                       |
| Context and private connectivity | Workspace instructions/skills/hooks, MCP, knowledge store, thread references, SSH/internal CLI reach                       | Versioned workflow/agent profiles, explicit context bundles, scoped internal connectors for unattended runtimes, and context-quality feedback | [`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md), [`knowledge-store.md`](knowledge-store.md), [`execution-runtime-security.md`](execution-runtime-security.md) |
| Triggers                         | Manual submit, local project cron prototype, and in-process UI/service events that do not yet wake durable tasks           | Durable catch-up/retry; PR/ticket/CVE/alert/webhook/chat/mobile adapters; authenticated trigger envelopes; always-available ingress           | [`automations.md`](automations.md), [`background-supervisor.md`](background-supervisor.md), cloud detached-worker phase                                                                        |
| Fleet coordination               | In-turn subagents, agent/PR provenance, cross-repo "my PRs" read, roadmap/long-task records                                | Campaign identity, fan-out/fan-in, per-repo isolation, aggregate dashboard, retry/escalation, and cross-repo budgets                          | [`background-supervisor.md`](background-supervisor.md), [`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md)                                                                   |

## Starter-workflow coverage

The guide proposes seven deliberately boring starting points. Copse can perform most of
them when a developer asks, but a self-driving workflow also needs a sensor, bounded
policy, repair action, validation, review gate, and outcome metric.

| Workflow                | What works now                                                                         | Factory gap / future consumer                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| First-pass code review  | Post-turn review can review Copse's own changed turn; general agents can inspect a PR. | Trigger on every selected PR, publish/dedupe findings, measure human acceptance and false-positive rate.                             |
| CI failure triage       | PR checks/log reads and the bounded read-only CI investigator are shipped on demand.   | The planned PR orchestrator supplies polling, cross-PR incident classification, one diagnosis, reruns, routing, and repair dispatch. |
| Merge-conflict handling | Worktrees isolate branches and an agent can resolve a requested conflict.              | Detect stale/conflicted fleet PRs, attempt only mechanical resolutions, validate, and escalate ambiguous conflicts.                  |
| CVE remediation         | An interactive agent can update a dependency and run tests.                            | Advisory trigger, affected-repo inventory, one campaign per advisory, scoped dependency/registry access, and coordinated PR rollout. |
| Test-coverage expansion | Agents can write tests; long-horizon tasks can retain a coverage goal.                 | Coverage-delta sensor, mutation/regression checks, bounded target selection, and measurable accepted-coverage gain.                  |
| Standards enforcement   | Repo hooks, lint/type/test commands, and agent edits are available.                    | Organization policy bundle, PR/repo trigger, safe auto-fix class, and cross-repo campaign.                                           |
| Release-note drafting   | An agent can summarize Git history/PR data when asked.                                 | Release/tag trigger, versioned template/context bundle, artifact publication draft, and correction-rate metric.                      |

These are **consumers**, not seven schedulers. Each registers a handler, trigger, policy,
and result schema with the background supervisor. Execution uses the shared runtime and
permission contracts. Multi-repository variants use the campaign primitive below.

## Newly explicit gaps and decisions

The existing plans cover much of the infrastructure, but the comparison makes six
cross-cutting requirements explicit.

### 1. Device independence is a separate milestone

A cloud container running shell commands while Copse's model loop remains on the laptop
is remote execution, not yet a background agent. A true Copse background run requires a
headless worker/control plane that can own the normal turn contract, supervisor lease,
provider call, tools, audit stream, and approval-blocked state while the desktop is
offline. The cloud-workspace plan now names this as a later phase rather than implying
that container provisioning completes it.

### 2. External ingress needs a trigger envelope

`cron`, a PR/ticket event, a CVE, an alert, and a chat command must normalize to one
durable, authenticated envelope containing:

- `triggerId`, source/type, observed time, project/campaign target, and dedupe key;
- immutable payload hash plus a bounded/redacted payload or artifact reference;
- actor/service identity and verification evidence;
- requested handler/profile, permission template, budgets, and review policy.

Ingress authorizes **enqueueing the declared workflow**, never arbitrary prompt text or
tool authority. Duplicate delivery is normal and must converge to one task/campaign.

### 3. Fleet work needs a campaign primitive

The supervisor's task tree needs an optional `campaignId` and explicit fan-out/fan-in
semantics before "update 500 repos" is a supported claim. A campaign records target-set
provenance, concurrency and spend budgets, per-target result/PR, retry state, aggregate
progress, cancellation, and an escalation summary. It does not share mutable checkouts
or credentials between targets.

The dark-factory PR orchestrator remains the nurse for resulting PRs; it is not the
generic campaign creator.

Both source patterns fit this contract: a **fleet** fans one workflow across many
repository targets, while a **swarm** assigns facets of one outcome to child tasks and
converges through a reviewed integration task. Fan-in never means that children share a
checkout or silently merge one another's output.

### 4. Unattended work uses non-human execution identity

A scheduled or event-triggered task must not silently inherit whichever developer last
opened the app. It runs as an automation principal with a workflow/project/runtime-bound
grant, short expiry, credential references rather than values, and a complete audit
record. Human review gates stay ordinary PR/approval gates. External side effects use
idempotency keys or leases so restart and duplicate delivery cannot double-act.

### 5. A factory needs production feedback, not only agent benchmarks

Each workflow declares a baseline and a small outcome schema before graduating beyond
observe-only. Common measures are:

- trigger-to-first-result and trigger-to-accepted-resolution;
- success/validation rate, human correction or rejection rate, and rollback/regression;
- human interventions per completed task (or time between disengagements);
- tokens, compute time, and external actions per accepted result;
- queue age and end-to-end PR/release lead time, not merely number of generated PRs.

The thread/supervisor audit log is the event source. Aggregates should be local and
redacted by default. Benchmark solve rate remains useful for model/profile selection but
is not evidence that the engineering system's bottleneck improved.

### 6. Reproducible workflows need versioned profiles and context bundles

The same generic prompt across every repository is not a reliable factory contract. A
registered workflow profile should name a model role, instruction/skill/knowledge
bundle references and content hashes, allowed tools/capabilities, validation command or
oracle, step/spend/action limits, review policy, and typed result schema. Each task
records the resolved profile version so an accepted or failed run can be reproduced and
compared. The user-defined agent-manifest follow-up in
[`grok-build-architecture-comparison.md`](grok-build-architecture-comparison.md) owns
the reusable profile shape; the supervisor stores only the resolved reference and
execution facts.

## Delivery sequence

1. **Measure and qualify workflows.** Select one bounded workflow, record its current
   turnaround/correction baseline, define observation-only output, and name rollback and
   review gates. CI triage remains the best first system workflow because Copse already
   has the read and diagnosis surface.
2. **Finish the durable local control plane.** Background-supervisor service, wake/event
   delivery, permission snapshots, headless-turn contract, and task UI. Migrate local
   cron and long-horizon continuation onto it.
3. **Ship PR-fleet observe/nurse.** Dark-factory O1–O4 with metrics, budgets, dedupe,
   and progressive `observe → nurse`; keep repair PRs review-gated.
4. **Add campaign fan-out/fan-in.** Prove a small, explicit repo set before broad
   organization discovery. CVE and standards workflows are the first useful consumers.
5. **Add detached Copse execution.** Provisioned isolated runtimes plus an automation
   principal and headless worker make tasks independent of the developer's device.
6. **Add authenticated trigger adapters.** GitHub/system events first; ticketing,
   generic webhooks, and chat/mobile entry points only after the same dedupe, identity,
   and audit gates pass.
7. **Expand from evidence.** Add review, coverage, conflict, and release workflows only
   where measured queue/cycle-time data identifies a real bottleneck.

## Claim gates

Copse may claim the following only when the corresponding evidence exists:

- **"Runs in the background"** — name whether this means app-open local, provider-managed,
  or Copse detached; never leave runtime lifetime implicit.
- **"Sandboxed"** — show filesystem/process/network/secret/lifecycle properties and the
  enforcement owner, per the runtime-security capability matrix.
- **"Event-driven"** — authenticated delivery, dedupe, persistence, replay/retry, and an
  audit link from trigger to task are implemented.
- **"Fleet"** — campaign fan-out/fan-in, aggregate progress, caps, cancel, and per-target
  isolation are implemented; a list of PRs is not a fleet control plane.
- **"Self-driving"** — at least one workflow runs from trigger through validated PR/draft
  under bounded policy, pages on exception, and demonstrates improved end-to-end outcome
  metrics without unacceptable correction/regression rates.

## Related plans

- [`background-supervisor.md`](background-supervisor.md) — durable task lifecycle,
  triggers, cancellation, concurrency, and campaign foundation.
- [`dark-factory-pr-orchestrator.md`](dark-factory-pr-orchestrator.md) — PR/CI fleet
  sensing, incident control, nursing, and repair routing.
- [`automations.md`](automations.md) — shipped app-open cron prototype and migration to
  the supervisor.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) — provisioned remote compute
  and eventual detached worker substrate.
- [`execution-runtime-security.md`](execution-runtime-security.md) — runtime properties,
  automation identity, grants, credentials, effects, and audit.
- [`industry-benchmarks.md`](industry-benchmarks.md) and
  [`skillsbench.md`](skillsbench.md) — offline agent/profile quality; complementary to
  production workflow metrics.
