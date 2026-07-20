# Copse-provisioned cloud workspaces

**Status: Proposed.** The app-level provision/attach workflow is not implemented.
Its remote-e2e and SSH-workspace prerequisites have since shipped, but they do not
provision cloud workspaces from Copse. This is stage two of the direction started in
[`remote-e2e-dev-loop.md`](remote-e2e-dev-loop.md): once cloud containers are
part of the _developer's_ loop (offloading e2e), let **Copse itself** spin up
cloud containers for any workspace — so a thread's execution, tests, and
builds can run on a disposable cloud machine instead of the user's laptop.

## Goal

From the app, for any opened workspace:

1. **Provision** a container on a cloud host (or a local/LAN Docker host)
   pre-baked with the workspace's toolchain and dependencies.
2. **Attach** — run agent work against it: shell commands, builds, tests, and
   eventually the full file/tool surface.
3. **Tear down** — explicitly, with a TTL backstop so forgotten containers
   never run up a bill.

The end state is Claude-Code-on-the-web-shaped: local UI, approvals, thread
store and LLM loop; remote filesystem and execution.

## What already exists to build on

- **Provisioning:** `scripts/burst-runners.mts` already launches AWS/Scaleway
  hosts, waits for SSH, uploads a compose dir, and manages TTL/teardown by
  tags. Stage one extracts its core into `scripts/lib/cloud-hosts.mts`.
- **Image:** `ci-runners/` builds a repo-parameterized image (`TARGET_REPO`
  build arg) that clones a repo and bakes its dependency tree — already
  repo-agnostic by design ("point it at any consumer").
- **Remote-workspace seams in the app:** the audit in
  [`ssh-remote-repo.md`](ssh-remote-repo.md) maps them: all workspace command
  execution funnels through the four spawns in
  `src/main/project-sandbox/spawn.ts`; the terminal renderer is
  transport-agnostic; path _resolution_ is centralized while file I/O is
  scattered (~15 modules); search shells out with `cwd = workspaceRoot`.
- **Isolation model:** [`thread-worktrees.md`](thread-worktrees.md) gives
  threads independent checkouts; a remote container is the same idea with the
  checkout on another machine.

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
5. **Secrets follow the existing rules.**
   - Cloud provider credentials are user settings stored like API keys —
     `safeStorage`-encrypted, env-var override, never in the workspace.
   - GitHub tokens: per-workspace, narrowest scope (Contents R/W on that
     repo), injected at attach time over SSH — never baked into image layers
     (keep the BuildKit-secret discipline from `ci-runners/README.md`).
   - LLM/provider keys **never leave the local machine** — the model loop
     stays local, mirroring `envForRendererChildProcess` scrubbing.
   - The approval gate keeps running locally (it is host-agnostic per the
     ssh-remote audit); a remote host does not weaken the write/shell
     approval story. `docs/threat-model.md` and `docs/ci-runner-security.md`
     get companion sections before GA.
6. **Cost is a first-class UI concern.** Every provisioned host carries the
   TTL-shutdown backstop and managed-by tags from the burst CLI. The UI always
   shows what is running (provider, shape, uptime, TTL) with one-click
   teardown; closing the workspace prompts about live containers. No silent
   fleets.

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

- **C0 — prerequisites (shared with stage one / ssh-remote):**
  `cloud-hosts.mts` extraction (stage one M0); ssh-remote Phase 0 (SSH auth
  plumbing) and the spawn-seam work from `ssh-remote-repo.md` Phases 1–2.
  Cloud workspaces should not start ahead of those seams landing.
- **C1 — provisioning service + local-docker provider.** Main-process
  `CloudWorkspaceProvider`, Settings → Cloud providers (creds via
  `safeStorage`), `copse-workspace` image + sshd entrypoint, lifecycle IPC +
  a minimal status pane. Validated entirely against local Docker.
- **C2 — remote command offload (first user-visible win).** Before the full
  remote workspace: a `run_remote` tool + UI action that executes a command
  (build, test suite, e2e) in the workspace's container against a snapshot
  push, streaming output into the thread — the in-app equivalent of stage
  one's CLI, and immediately useful for "check e2e while iterating".
- **C3 — full remote workspace.** Wire the provisioned container in as an
  SSH-remote workspace per `ssh-remote-repo.md` Phases 2–5: file tools,
  terminal, git pane, search on the container; UI affordance to open a
  workspace "in the cloud".
- **C4 — cloud providers + guardrails.** Scaleway then AWS providers via the
  shared core; TTL/idle auto-teardown, cost/status surfaces, threat-model and
  security-doc updates.
- **C5 — per-thread containers.** The `thread-worktrees.md` allocation policy
  extended with a third mode: thread → fresh container (worktree semantics,
  machine-level isolation), enabling parallel agents that don't even share a
  host.

## Risks / open questions

- **Sequencing risk:** C3 is gated on the ssh-remote plan's phases, which are
  the largest unbuilt piece. C1/C2 are deliberately scoped to be valuable
  without it — if ssh-remote slips, command offload still ships.
- **Image freshness:** per-workspace baked images go stale on lockfile
  changes; same answer as stage one (lockhash gate, explicit rebake) but
  needs an in-app surface.
- **Provider sprawl:** stop at local-docker + Scaleway + AWS until real
  demand; the interface exists precisely so we don't pre-build more.
- **Billing failure modes:** TTL backstop + tags are necessary but not
  sufficient; C4 should add reconciliation on app start ("these tagged hosts
  exist but no workspace references them — tear down?").
- **Windows/macOS containers:** out of scope — containers are Linux;
  platform-specific work stays local.
