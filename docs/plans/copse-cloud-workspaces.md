# Copse-provisioned cloud workspaces

**Status: Proposed.** The app-level provision/attach workflow is not implemented.
Its remote-e2e and SSH-workspace prerequisites have since shipped, but they do not
provision cloud workspaces from Copse. This is stage two of the direction started in
[`remote-e2e-dev-loop.md`](remote-e2e-dev-loop.md): once cloud containers are
part of the _developer's_ loop (offloading e2e), let **Copse itself** spin up
cloud containers for any workspace — so a thread's execution, tests, and
builds can run on a disposable cloud machine instead of the user's laptop.

Security, credential, network, checkpoint, and runtime lifecycle requirements are
owned by [`execution-runtime-security.md`](execution-runtime-security.md). This plan
owns provisioning providers, workspace attachment, cost UX, and rollout order.
The distinction between remote execution and a device-independent background agent is
mapped in [`background-agents-capability-map.md`](background-agents-capability-map.md).

## Goal

From the app, for any opened workspace:

1. **Provision** a container on a cloud host (or a local/LAN Docker host)
   pre-baked with the workspace's toolchain and dependencies.
2. **Attach** — run agent work against it: shell commands, builds, tests, and
   eventually the full file/tool surface.
3. **Tear down** — explicitly, with a TTL backstop so forgotten containers
   never run up a bill.

The end state keeps the UI, policy engine, thread store, and provider-neutral LLM loop
local while filesystem and command execution run remotely. The remote runtime is
replaceable compute attached to the logical thread, not the owner of the conversation.

That end state completes **remote interactive execution**, not by itself a Copse
background agent: if the desktop/model loop disconnects, the guest has no authority to
continue reasoning. A later detached-worker phase may move ownership of a supervised
turn to an always-available control plane, but only through the same thread, runtime,
grant, and audit contracts. Provisioning a container must not be presented as completing
device independence.

This is distinct from the shipped **managed remote agent** path in
`src/main/services/remote/`: managed agents hand the prompt and repository resource to
a provider-owned agent/runtime. A Copse-provisioned cloud workspace keeps Copse's own
loop and tool policy in control and uses a runtime Copse provisions and reconciles.

## What already exists to build on

- **Provisioning:** `scripts/lib/cloud-hosts.mts` is the shipped shared core behind
  burst runners and remote e2e. It launches AWS/Scaleway hosts, waits for SSH, and
  manages TTL/teardown by tags.
- **Image:** `ci-runners/` builds a repo-parameterized image (`TARGET_REPO`
  build arg) that clones a repo and bakes its dependency tree — already
  repo-agnostic by design ("point it at any consumer").
- **Remote-workspace stack in the app:** the core in
  [`ssh-remote-repo.md`](ssh-remote-repo.md) has shipped: connection management,
  execution and PTYs, filesystem, git, search, and UI already target a remote account.
  A provisioned runtime reuses those tools and transport seams.
- **Execution-ownership direction:** [`thread-worktrees.md`](thread-worktrees.md) is
  moving mutable state and checkout allocation under trusted project/thread ownership.
  A per-thread remote runtime extends that ownership model; a worktree or container is
  not by itself a security boundary.
- **Runtime-security model:** [`execution-runtime-security.md`](execution-runtime-security.md)
  defines capability reporting, per-execution grants, brokered egress/secrets,
  lifecycle reconciliation, checkpoints, and canonical audit events across local and
  cloud targets.

## Decisions

1. **A cloud workspace is provisioner + SSH-remote workspace — not a second
   remote-execution path.** The hard problem (running Copse's tools against a
   remote filesystem/host) is already mapped by `ssh-remote-repo.md`, and a
   container we provision is strictly the _easy_ case of that plan: known
   image, known user, key we generated, no host-key surprises. So the
   container exposes `sshd`, and everything above the transport is the
   SSH-remote plan, unchanged. We do not build a bespoke docker-exec RPC that
   would duplicate Phases 1–6.
2. **Provider abstraction lives in the main process; the provisioning core is
   shared with the CLI.** A `CloudWorkspaceProvider` service wraps the
   `cloud-hosts` core: `provision(spec) → { hostId, ssh }`, `status()`,
   `teardown()`. Providers: **local-docker** first (any Docker socket/host —
   free, fast, validates the whole lifecycle with zero cloud creds), then
   **Scaleway** (cheapest, already scripted), then **AWS**. The interface is
   deliberately small so Fly/Hetzner/etc. are additive.
3. **Generalize the runner image into a `copse-workspace` image.** Same
   Dockerfile lineage (toolchain + optional `TARGET_REPO` clone + dep bake),
   but the entrypoint is `sshd` with an injected per-session public key — no
   GitHub runner registration, ever. Repos without a bake just get the
   toolchain layer and clone at attach time.
4. **Workspace sync is git-first.** The container clones from the remote
   (GitHub) using a per-workspace token, then the local app pushes snapshot
   commits (the `createWorktreeBackup()` mechanism, as in stage one) to carry
   uncommitted state over, and pulls result commits back. No continuous
   file-mirroring in v1; the agent's edits happen _on the container_ via the
   remote tool surface.
5. **Secrets follow the existing rules and move toward mediation.**
   - Cloud provider credentials are user settings stored like API keys —
     `safeStorage`-encrypted, env-var override, never in the workspace.
   - GitHub tokens: per-workspace and narrowest scope (Contents R/W on that repo).
     The target is host-side Git/HTTP mediation so the token never enters the guest.
     If an initial implementation must inject a raw token, it is short-lived,
     execution-scoped, absent from the shell environment and image layers, removed
     after bootstrap/use, and excluded from checkpoints.
   - LLM/provider keys **never leave the local machine** — the model loop
     stays local, mirroring `envForRendererChildProcess` scrubbing.
   - The approval gate keeps running locally (it is host-agnostic per the
     ssh-remote audit); a remote host does not weaken the write/shell
     approval story. Approval grants are bound to project, thread, turn, runtime,
     operation, and expiry.
6. **Egress is deny-by-default and per runtime.** Workload sockets do not receive
   unrestricted internet access. A host-side gateway mediates approved destinations
   and denies cloud metadata endpoints, private networks, redirects to unapproved
   origins, and cross-thread grant reuse. Control-plane, Git, package-registry, and
   user-requested web access are separate grants.
7. **The runtime lifecycle is reconciled, not fire-and-forget.** Copse persists desired
   and observed state, gives every runtime stable project/thread ownership, and makes
   create/stop/teardown idempotent. Startup reconciles tagged resources that outlived a
   crash or local uninstall. A checkpoint is restorable only after all artifacts are
   durable and integrity-checked.
8. **Cost is a first-class UI concern.** Every provisioned host carries the
   TTL-shutdown backstop and managed-by tags from the burst CLI. The UI always
   shows what is running (provider, shape, uptime, TTL) with one-click
   teardown; closing the workspace prompts about live containers. No silent
   fleets.
9. **A container is not the host boundary.** The workload runs unprivileged with a
   read-only base image and dedicated writable storage, but a container alone does not
   justify a hostile multi-tenant claim. v1 uses a dedicated user-controlled host or
   VM; stronger VM isolation can be added behind the same runtime contract.
10. **Detached execution is an explicit ownership transfer.** A background run records
    which worker holds the supervisor lease, automation principal, provider-call
    authority, runtime, and thread-spine append lease. The desktop becomes an observer
    or approval endpoint until the lease is released; local and remote loops must never
    advance the same turn concurrently.

### Alternatives considered

- **Drive GitHub Actions instead of own containers** — rejected: minutes-level
  latency, no interactive shell/terminal, CI coupling, and no path to the
  full remote-workspace experience.
- **Docker-exec transport instead of SSH** — rejected: duplicates the
  ssh-remote plan's transport layer for containers only, and breaks the
  "provisioned container is just an easy SSH remote" unification (LAN boxes,
  user-supplied hosts, and cloud VMs all speak SSH already).
- **Continuous bidirectional file sync (mutagen-style)** — deferred: v1 treats
  the container as the source of truth while attached; git snapshots cover
  carry-in/carry-out. Sync engines earn their complexity only if the
  remote-editing UX proves insufficient.

## Phases

- **C0 ✅ — prerequisites (shared with stage one / ssh-remote).** The
  `cloud-hosts.mts` extraction, remote-e2e loop, and SSH workspace execution/file/git/UI
  stack have shipped. Port forwarding, semantic indexing, and ACP-on-SSH remain
  independent limitations rather than blockers for command offload.
- **C1 — provisioning service + local-docker provider.** Main-process
  `CloudWorkspaceProvider`, Settings → Cloud providers (creds via
  `safeStorage`), `copse-workspace` image + sshd entrypoint, lifecycle IPC +
  a minimal status pane. Implement the `ExecutionRuntime` lifecycle/capability
  contract and canonical runtime-state events here; validate entirely against local
  Docker before adding cloud credentials.
- **C2 — remote command offload (first user-visible win).** Before the full
  remote workspace, route a command (build, test suite, e2e) through the common runtime
  contract against a snapshot push, streaming output into the thread. The UI may offer
  a dedicated action, but it must not introduce a second permission or process-record
  path.
- **C3 — full remote workspace.** Wire the provisioned container in as an
  SSH-remote workspace per `ssh-remote-repo.md` Phases 2–5: file tools,
  terminal, git pane, search on the container; UI affordance to open a
  workspace "in the cloud".
- **C4 — cloud providers + guardrails.** Scaleway then AWS providers via the
  shared core; TTL/idle auto-teardown, startup/orphan reconciliation, cost/status
  surfaces, deny-by-default egress, credential mediation, capability display, and the
  execution-runtime-security plan's container-image hardening acceptance suite.
- **C5 — per-thread containers.** The `thread-worktrees.md` allocation policy
  extended with a third mode: thread → fresh container (worktree semantics,
  runtime-level separation), enabling parallel agents that need not share a guest.
  Dedicated-host/container does not become a multi-tenant security claim.
- **C6 — suspend, restore, rollback, and fork.** Publish portable checkpoint manifests
  from the thread spine, workspace snapshot, and runtime metadata. Add backend-specific
  process/VM snapshots only as optional capabilities after crash recovery and teardown
  are proven.
- **C7 — detached Copse worker (true background-agent milestone).** Run the shared
  headless-turn contract and background supervisor on an always-available worker;
  acquire a fenced per-task/thread lease; use an automation principal and scoped
  runtime/credential grants; stream canonical events to the durable thread spine; park
  safely on human approval; and let desktop clients observe or take over after an
  explicit handoff. Start with one task in one repo. Fleet campaigns and external
  trigger ingress consume this only after single-task crash/replay behavior is proven.
  Exit gate: disconnect the initiating desktop during model and tool execution, restart
  both sides in adversarial order, and observe one converged task with no duplicate
  provider turn, GitHub action, commit, or spine append.

## Risks / open questions

- **Sequencing risk:** the SSH core is no longer the blocker. C1 may validate
  provisioning independently, but product execution must not invent a cloud-only
  permission, event, or lifecycle path ahead of the execution-runtime-security plan's capability-reporting and brokered-egress phases.
- **Image freshness:** per-workspace baked images go stale on lockfile
  changes; same answer as stage one (lockhash gate, explicit rebake) but
  needs an in-app surface.
- **Provider sprawl:** stop at local-docker + Scaleway + AWS until real
  demand; the interface exists precisely so we don't pre-build more.
- **Billing failure modes:** TTL backstop + tags are necessary but not
  sufficient; C4 should add reconciliation on app start ("these tagged hosts
  exist but no workspace references them — tear down?").
- **Credential compatibility:** some developer tools assume a raw token or credential
  file. Prefer broker-aware Git/package integrations; any compatibility injection must
  be explicitly labelled as a reduced guarantee and excluded from snapshots.
- **Egress compatibility:** builds often fetch from dynamic registries and mirrors.
  Grants need explainable denial output and scoped expansion without falling back to
  an unrestricted runtime profile.
- **Host compromise:** a dedicated VM protects the user's laptop but is still inside
  the trust path for workspace contents and command output. Encrypt transport, minimize
  durable secrets, keep the control plane local, and document provider-host exposure.
- **Windows/macOS containers:** out of scope — containers are Linux;
  platform-specific work stays local.
- **Split-brain risk:** an app and detached worker can both believe they own a turn.
  C7 needs a renewable, fenced lease and idempotent external actions; presence/status
  heartbeats without fencing are insufficient.
