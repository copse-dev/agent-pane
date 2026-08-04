# Contained autonomy for long-horizon work

**Status: Proposed.** Nothing here is implemented. This plan proposes a per-thread
_container_ runtime plus a _non-blocking_ permission tier, so a long-horizon run can
keep working for hours without stopping at a modal — and says precisely which prompts
that removes and which it must not.

Security, egress, credential, lifecycle, checkpoint, and audit requirements are owned by
[`execution-runtime-security.md`](execution-runtime-security.md); provisioning providers
and cost UX by [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md). This plan owns
the product question those two defer: **when containment is available, what changes about
asking the user, and what must not.**

## Why this plan exists

Two things are now true at once.

1. **We have working Docker execution.** The Terminal-Bench and SkillsBench adapters
   (`benchmarks/terminal_bench/`, `benchmarks/skillsbench/`) run Copse's headless agent
   loop on a host and forward `run_shell` into a Docker task container, unattended, for
   hours, with zero human approvals, and produce a sealed capsule of what happened.
   `ci-runners/` and `scripts/lib/cloud-hosts.mts` provision and reap disposable hosts,
   and `scripts/remote-e2e.mts` already runs a one-shot container per invocation.
2. **Long-horizon work is where prompts hurt most.** The grind cases in
   [`long-horizon-tasks.md`](long-horizon-tasks.md) — clear a lint/type backlog, drive CI
   to green, a deep investigation pass — are exactly the runs a user wants to start and
   walk away from. Today they stop at the first sandbox-escalation prompt and wait,
   possibly for hours, having done a fraction of the work.

`docs/threat-model.md` names both halves of the problem: scenario 6 (**approval cliff** —
an approval hands over more authority than the user meant) and principle 3 (**friction
must stay productivity-neutral** — a control that hurts gets switched off). The current
answer to a user who wants an uninterrupted long run is Guarded YOLO, whose containment is
`'project-sandbox' | 'unsandboxed'` (`src/shared/types/guarded-yolo.ts`). On a machine
without an ASRT backend that reduces to _unsandboxed_ — the worst trade in the product:
maximum autonomy, minimum containment.

A container changes the trade. It is the only lever we have that lets us grant _more_
autonomy while holding _more_ back.

## The premise, corrected

The proposal — "containment is lower risk, so offer it for long work and stop prompting" —
is right in direction and wrong if taken whole. Prompt reduction comes from **two
separable levers**, and the container is only one of them.

- **Lever A — containment raises the auto-run ceiling.** Actions whose blast radius is
  confined to a disposable guest need no human. Writing outside the workspace, installing
  a toolchain, running an unrecognised binary, `sudo` inside the guest, deleting the
  checkout: all recoverable by `docker rm`. Today most of these prompt.
- **Lever B — deferral removes the _blocking_ property of the rest.** A run that must
  survive the user being asleep cannot ask questions synchronously. The remaining
  decisions become a reviewed queue, not a modal.

Lever B is worth more for overnight work than Lever A, is cheaper to build, and works on
today's host sandbox with no Docker at all. Ship it first.

**What containment does not buy.** A container narrows filesystem, process, and (with a
broker) network blast radius. It does nothing about effects whose blast radius _leaves_
the guest by design:

| Effect class                                                         | Contained? | Gate after this plan                               |
| -------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| Write/delete anywhere in the guest, install anything, run any binary | Yes        | Auto-run, no prompt                                |
| Read the project's own source and history                            | Yes        | Auto-run (already)                                 |
| Network fetch to an allowlisted origin                               | Mediated   | Auto-run; denial recorded, never auto-widened      |
| Network to anything else                                             | No         | Denied at the broker; queued as a deferred request |
| `git push`, PR/issue/comment writes, package publish, deploys        | **No**     | Never auto-run — executes on the host after review |
| Anything spending money or messaging a human                         | **No**     | Never auto-run — deferred                          |
| Reading the user's host filesystem or credentials                    | **No**     | Impossible by construction (guest holds neither)   |

So the target is not "no prompts". It is: **no prompt that blocks, and no prompt for an
effect that dies with the container.**

**And one risk goes _up_.** An agent working unattended for six hours does far more than
one working for twenty minutes: more tokens and money spent, a larger diff to review, and
a longer runway for an indirect prompt injection (threat scenario 1) to act on. Containment
caps the damage per action; it does not cap the total. Budgets, an egress allowlist, and an
end-of-run review record are therefore not polish — without them this is a net risk
increase, and the plan should not ship.

## What the Docker eval proves, and what it does not

Being precise about this matters, because the reuse story is the reason to do this now.

**Proven by the eval harnesses:**

- Copse's agent loop drives a containerised workspace for a full task, unattended, with
  the model loop and all provider credentials on the host side and never in the guest.
- Long unattended runs are survivable operationally: Harbor/BenchFlow lifecycle, disk and
  daemon health checks, fatal-infrastructure detection
  (`terminalBenchFatalInfrastructureOutput`), per-task image pinning by digest, and
  bounded per-command timeouts.
- Disposable hosts provision, run, and reap reliably at fleet scale
  (`run-terminal-bench-fleet.mts`, `cloud-hosts.mts`), with TTL backstops and tags.
- A run can be sealed into an evidence capsule — dataset/task/profile digests, tokens,
  tool counts, elapsed time, source commit — that answers "what exactly ran?" afterwards.

**Not proven, and required before this is a product:**

- **Tool surface.** The bench bridge forwards `run_shell` (plus a bounded `write_file`).
  A real thread also needs file tools, git, search, diffs, and a PTY. Those exist for the
  SSH transport — which is why the container must _be_ an SSH target rather than a second
  RPC (see Decision 1).
- **The user's repository.** Bench tasks arrive as a pinned image with throwaway contents.
  A product run carries uncommitted local state in and results back out.
- **Credentials.** The bench guest needs none. A product guest wants a Git remote and may
  want registry auth — the hard part this plan deliberately answers with "no credentials
  in the guest in v1".
- **Egress policy.** Bench containers get whatever the task environment gives them. A
  product guest needs deny-by-default with an explainable allowlist.
- **Review, cost, and interruption UX.** The eval has none: no user is watching, no one
  reviews the diff, and the bill is a CI line item.

## Binding decisions

Changing one of these requires updating this document in the same change.

1. **A container is an ephemeral, Copse-owned SSH host — not a new tool surface.**
   [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) decision 1 already rejects a
   bespoke docker-exec RPC, and it is right: every file, git, search, terminal, and shell
   path in `src/main` already routes through `ExecutionTarget`
   (`src/main/services/ssh-workspace/execution-target.ts`, consumed by
   `project-sandbox/spawn.ts`, `workspace-fs/`, `search/indexed-grep.ts`, `acp/`). The
   provider starts a container running `sshd` with a generated per-run keypair and
   registers it as an SSH host carrying `provenance: 'copse-container'`. Routing is
   unchanged; only the host record is new. The bench bridge stays a bench adapter and is
   not promoted.
2. **Provenance decides capabilities — `kind: 'ssh'` alone claims nothing.** A user's BYO
   SSH box is a user-selected trust boundary with no Copse-enforced containment; a
   Copse-provisioned container has known image, user, egress policy, and lifecycle. The
   capability record (`processIsolation`, `network`, `secrets`, `filesystem`, per
   `execution-runtime-security.md`) is attached to the host record and displayed. Autonomy
   is offered only where the record says `container`.
3. **No credentials in the guest in v1.** The model loop, provider keys, and Git
   credentials stay on the host — the property the eval already has and the one that makes
   "don't ask, just run" defensible. Carry-in and carry-out are host-driven git snapshots
   over the run's own SSH connection (the `createWorktreeBackup()` + bare-repo mechanism
   `remote-e2e.mts` already uses). The agent commits inside the guest; **the host pushes,
   after review.** A secret canary test enforces absence.
4. **Egress is deny-by-default and named.** A run declares its allowlist up front
   (package registries the project actually uses, plus project-declared hosts). Denials are
   recorded and surfaced with the exact `host:port` — the pattern `recordNetworkDenial`
   already implements for ASRT — and become deferred requests. A denial never auto-widens
   the allowlist, and there is no unrestricted profile.
5. **Autonomy is per-thread, session-only, and explicitly armed.** It reuses the Guarded
   YOLO ledger shape (`GuardedYoloRegistry`): nothing in settings, so no migration,
   restart, or default can turn it on. Arming names the runtime and the budgets.
6. **The gate never blocks during an autonomy run.** Every decision resolves to `allow`,
   `deny`, or `defer`. `defer` returns a typed error to the agent — "queued for review,
   continue with other work" — and appends to a review queue. A run ends by budget, by
   completion, or by the user; never by a modal nobody is there to answer.
7. **Budgets are mandatory, not optional.** Wall-clock TTL, token/cost ceiling, and idle
   reap are set at arm time and enforced by the runtime. Hitting one **suspends** the run
   with its state intact; it does not silently continue and does not silently discard.
8. **Every autonomy run produces a review record.** Image digest, capability record,
   egress allow/deny log, deferred queue, commits produced, tokens/cost, teardown outcome.
   Modelled on the bench capsule manifest; written to the thread spine as canonical events
   per `execution-runtime-security.md`, not to a hook subscriber.
9. **A container is not a hostile-workload boundary, and we never say it is.** Access to
   the Docker daemon is equivalent to host root; the daemon and its images are inside the
   user's trust path. The UI states the boundary honestly (threat-model principle 5:
   approval and containment are distinct). No multi-tenant claim, ever.
10. **Classifiers never grant authority.** Inherited verbatim from
    `execution-runtime-security.md` decision 10. Routing and explanation only.

## Phases

Each phase is independently shippable and independently valuable. A2 is deliberately first
after measurement, because it needs no Docker at all.

### A0 — measure which prompts a container would actually remove

Before building a runtime, instrument the thing we are claiming to fix. `recordDecision`
and `recordPermissionDecision` (`security/decision-log-store.ts`) already write decisions;
add a **prompt-cause** dimension (sandbox escalation, hard-external, no containment
available, harm gate, network-scope overlap, MCP/web origin, install) and a summary over a
run.

Exit gate: a report over at least ten real long runs, on macOS and on Linux, breaking down
prompts by cause and by "would a container have removed this?" If the answer is dominated
by outward-effect prompts rather than containment prompts, A3 is not worth building and
this plan stops at A2.

### A1 — local Docker runtime provider

This is `copse-cloud-workspaces.md` C1 narrowed to local Docker and to one consumer.

- `CloudWorkspaceProvider` in the main process with a `local-docker` implementation:
  `provision(spec) → { runtimeId, ssh }`, `status()`, `teardown()`. No cloud credentials.
- A `copse-workspace` image from the `ci-runners/` lineage: toolchain layer, optional
  dependency bake gated by lockhash, unprivileged user, read-only base with a dedicated
  writable volume, `sshd` entrypoint with an injected per-run public key. Reuse the
  registry publish/pull flow (`COPSE_CI_REGISTRY`) rather than baking on every start.
- Lifecycle per `execution-runtime-security.md`: persisted `desiredState`/`observedState`,
  idempotent `stop`, TTL and idle reap, startup reconciliation of tagged-but-unreferenced
  containers.
- Capability record attached to the host entry and rendered wherever the runtime is shown.
- Generalise the eval's operational guards into a shared module: daemon health, free-disk
  floor, fatal-infrastructure detection (lift from `scripts/lib/terminal-bench.mts`).

No permission behaviour changes in this phase. The runtime is selectable and everything
prompts exactly as it does today.

Exit gate: a thread can run its full existing tool surface against a provisioned container;
killing the app mid-provision, mid-run, and mid-teardown converges to one observable state;
an orphan is detected and offered for teardown after restart; teardown is idempotent.

### A2 — non-blocking deferral and the review queue

No Docker. Works on the host sandbox today.

- Add `defer` to the gate's outcome vocabulary alongside `allow`/`deny`, mapped onto the
  headless contract's permission vocabulary (`packages/agent/src/headless-contract.ts`)
  rather than inventing a fourth dialect.
- A deferred decision returns a typed tool error naming the reason and telling the agent
  to continue with other work; it does not fail the turn.
- A per-thread review queue: what was requested, when, the exact command/URL/argument, the
  reason, and the point in the transcript. Reviewing one can approve-and-replay,
  approve-for-the-rest-of-the-run, or reject with a note the agent sees.
- The queue is visible while the run continues, and summarised when it ends.

Exit gate: a run whose every escalation is deferred completes without a modal, records
each deferral, and the user can approve one afterwards and have it replay against the same
runtime. An e2e spec covers the queue's states.

### A3 — the `container` containment tier

Only after A0 justifies it and A1 provides the runtime.

- Extend `GuardedYoloContainment` to `'container' | 'project-sandbox' | 'unsandboxed'` and
  make the tier a property of the resolved runtime, never of a setting.
- In `ensureShellCommandPermitted` (`security/permission-gate.ts`), the container tier
  auto-allows the contained-blast-radius classes in the table above, including the ones the
  host tier must prompt for (writes outside the workspace root, unrecognised binaries,
  privilege changes inside the guest).
- The harm gate (`assessShellHarm`) stays, with its meaning narrowed to what the container
  does not contain: outward effects and the guest's own Git remote configuration. Its
  outcome under autonomy is `defer`, not a prompt.
- Attempts to reach the host — mounts, the Docker socket, host paths — are `deny` with a
  recorded reason. They should be impossible; the gate records them because a hit means
  either the image or the policy is wrong.
- `unsandboxed` + autonomy remains available only with an explicit, separately-worded
  confirmation and is never the default of anything.

Exit gate: a permission matrix test enumerating command classes × runtime tier ×
autonomy state, asserting the exact verdict, with the negative cases (host escape denied,
outward effect deferred) as first-class assertions.

### A4 — egress and credential enforcement

- Deny-by-default egress at the container boundary with a named per-run allowlist;
  denials recorded with `host:port` and raised as deferred requests.
- Deny cloud-metadata endpoints and private ranges outright (per
  `execution-runtime-security.md`), independent of the allowlist.
- Secret canary tests: a marker value present in the host environment and in Copse's
  settings must be absent from the guest environment, filesystem, image layers, and the
  run record.
- Git carry-in/carry-out over the run's own SSH connection; no token in the guest. Host-side
  push happens only through the review queue.

Exit gate: the canary is absent from every guest surface; an unapproved origin fails with
an explainable denial; one thread's runtime cannot reuse another's grant; approved work
still succeeds.

### A5 — long-horizon integration

Wire the runtime and the queue into the features that actually want them.

- `track_long_task` (`copse.long-horizon-tasks`) supplies the terminal condition; the run
  continues until the checklist is complete, a budget is hit, or the user stops it — the
  "self-paced loop" that plan lists as not-yet-built.
- Chunked commit cadence inside the guest so a long run stays resumable and reviewable,
  and so a suspended run has a meaningful diff.
- Wakes, cancellation, and permission snapshots come from the background supervisor
  (`background-supervisor.md`) as a consumer, not a second scheduler.
- Budgets enforced and surfaced live: elapsed vs TTL, tokens/cost vs ceiling, deferrals
  outstanding.
- End-of-run record per Decision 8, presented as a review: here is the diff, here is what
  was blocked, here is what it cost, here is what it wants you to approve.

Exit gate: an overnight run on a real backlog completes or suspends cleanly, produces a
reviewable diff and a complete record, and never blocks on a modal.

### A6 — acceptance measured with the eval we already have

The point of building on the eval harness is that it can grade the result.

- Add a product-aligned arm that runs the _product's_ container runtime and permission
  tier, rather than the bench bridge, over an internal grind corpus (lint backlog, failing
  suite, CI-to-green) plus the existing Terminal-Bench/SkillsBench profiles.
- Compare against the host-sandbox arm on: task completion, wall-clock to completion,
  human interventions required, tokens/cost, deferrals raised, and deferrals a human then
  approved (a high approve-rate means the gate is too tight; a high reject-rate means the
  autonomy tier is too loose).
- Report as a paired comparison with intervals, the same discipline `industry-benchmarks.md`
  applies to profile ablations. This is trend evidence for a product decision, not a
  leaderboard claim.

Exit gate: a written result. Contained autonomy ships on by-offer only if it improves
completion-without-intervention without a materially worse reject-rate on deferrals.

### A7 — beyond the laptop (deferred)

Remote hosts via `cloud-hosts.mts`, per-thread containers, and checkpoint/suspend/resume
belong to `copse-cloud-workspaces.md` C4–C6 and `execution-runtime-security.md` R4–R5. This
plan does not duplicate them; it should be a clean consumer when they land.

## Test plan

| Area               | Tier        | What it must prove                                                                    |
| ------------------ | ----------- | ------------------------------------------------------------------------------------- |
| Runtime lifecycle  | unit        | State machine converges; `stop` idempotent; orphan reconciliation                     |
| Provider           | integration | Provision → exec → teardown against a real local daemon; skipped when absent          |
| Target routing     | unit        | Container host routes shell/fs/git/search through the SSH adapter unchanged           |
| Permission matrix  | unit        | Command class × tier × autonomy → exact verdict, including every deny and defer       |
| Deferral queue     | unit + e2e  | Ordering, replay after approval, reject-with-note, survives run end                   |
| Egress             | integration | Allowlisted origin succeeds; metadata/private/unlisted denied and recorded            |
| Secret canary      | integration | Absent from guest env, fs, image layers, run record                                   |
| Budgets            | unit        | TTL, token, and idle limits suspend rather than continue or discard                   |
| Review record      | unit        | Complete and integrity-checked before it is presented as a record                     |
| UI honesty         | e2e         | Capability text matches the resolved runtime; BYO SSH never shows a containment claim |
| End-to-end outcome | bench       | A6's paired comparison                                                                |

## Risks and open questions

- **A0 may kill A3.** If most prompts in real long runs are outward-effect prompts, the
  container removes few of them and A2 alone is the answer. That is a good outcome to
  discover for the cost of instrumentation.
- **Docker is not on most users' machines**, and on macOS and Windows it is a VM with real
  file-IO cost. Bind-mounting a large repo into a Linux VM is slow enough to change what
  "long-horizon" means. Mitigation: git carry-in into a container-local volume (already the
  design), and measure image pull and first-build latency in A1 before committing to a
  default.
- **Trust laundering.** A contained agent cannot hurt the host, but it can produce a
  plausible malicious commit that the user merges. The diff review is the boundary, and it
  is a human boundary. The end-of-run record must make provenance and scale of change
  obvious rather than burying them.
- **Injection runway.** Six unattended hours is a long time for repo/web content to steer
  the agent. Egress allowlist, budgets, and the deferral record are the containment; the
  plan should not ship A3/A5 without A4.
- **Cost.** An unattended run can spend a lot. The token/cost ceiling is a Decision, not a
  setting to forget; the arming UI must state the ceiling in currency.
- **Image drift.** A baked image goes stale on lockfile change. Same answer as remote-e2e:
  lockhash gate plus explicit rebake, but this one needs an in-app surface.
- **Open — one mode or two?** Recommendation: extend Guarded YOLO's ledger rather than
  adding a parallel mode, so there is one place where "this thread may act without asking"
  lives, with containment as a property of it. The alternative — a distinct "unattended
  run" concept — reads more clearly in the UI but risks two ledgers and two audit paths.
  Decide before A3.
- **Open — what does a deferral do to a run's momentum?** An agent told "queued, carry on"
  may loop on the same blocked action. The nudge/steering machinery in the bench profiles
  is the closest prior art; A2 should measure repeat-request rate.

## Non-goals

- Making a container a hostile-workload or multi-tenant boundary.
- Running the model loop, or provider credentials, inside the guest.
- Auto-approving any effect that leaves the container.
- A second execution transport, permission vocabulary, event stream, or scheduler.
- Requiring Docker for any existing workflow, or changing any default without A6.
- Cloud provisioning, checkpointing, or suspend/resume — owned elsewhere.

## Relationship to existing plans

- [`execution-runtime-security.md`](execution-runtime-security.md) owns the capability,
  grant, egress, credential, lifecycle, checkpoint, and audit contracts. This plan is a
  consumer and must not fork them; A1 is its R4 narrowed to local Docker, A4 its R2.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) owns provisioning providers and
  cost UX. A1 is C1 restricted to `local-docker`; A7 hands the rest back.
- [`long-horizon-tasks.md`](long-horizon-tasks.md) owns the checklist and terminal
  condition. A5 supplies the self-paced loop and commit cadence it lists as unbuilt.
- [`background-supervisor.md`](background-supervisor.md) owns durable task identity, wakes,
  and cancellation. This plan is a consumer; it adds no timers.
- [`auto-approval-classifier.md`](auto-approval-classifier.md) and
  [`command-sandboxing-routing.md`](command-sandboxing-routing.md) own the shipped
  prompt-reduction levers on the host tier. A3 adds a tier above them and must not weaken
  either.
- [`industry-benchmarks.md`](industry-benchmarks.md) owns the harness A6 measures with.
- [`thread-worktrees.md`](thread-worktrees.md) owns checkout allocation. A worktree is
  complementary to, not a substitute for, runtime isolation.
- [`../threat-model.md`](../threat-model.md) scenario 6 and principles 3 and 5 are the
  standing constraints this plan is written against.
