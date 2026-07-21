# Execution runtime security

**Status: Proposed.** This is the implementation plan for making Copse's local,
SSH, and future provisioned-cloud execution paths share one explicit security and
lifecycle model. Existing behavior is unchanged until a phase below lands.

## Why this plan exists

Copse has accumulated several useful execution paths, but their guarantees differ:

| Execution surface                 | State                     | Where work runs                       | Enforcement owner                                                                        |
| --------------------------------- | ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Local shell/background tools      | Shipped                   | The user's machine                    | Copse approval policy plus macOS ASRT when available                                     |
| Local ACP agents                  | Shipped                   | A child process on the user's machine | Copse's ACP sandbox profile on macOS; conservative prompts elsewhere                     |
| SSH workspaces                    | Shipped core              | A user-selected remote host           | The remote account/host; Copse's local seatbelt does not cross SSH                       |
| Managed remote agents             | Shipped                   | A provider-managed sandbox            | The remote provider; Copse controls the handoff and local record, not the guest boundary |
| Remote e2e                        | Shipped developer tooling | A fresh container on a chosen host    | The container/host and the remote-e2e lifecycle scripts                                  |
| Copse-provisioned cloud workspace | Proposed                  | A Copse-created container or VM       | Must be defined by this plan before product launch                                       |

Today, an approval can also change the execution context sharply: a command that
needs network or host access may move from a workspace-confined, network-denied
process to a fully unsandboxed process. Separately, raw tool credentials such as
GitHub, package-registry, or cloud tokens may remain available to child processes even
though model-provider keys are scrubbed.

The target is not one mandatory virtualization technology. It is a common contract in
which Copse can state, test, and display the actual properties of whichever runtime is
selected.

## Security properties are separate

Every runtime reports these properties independently. No single `sandboxed: true`
flag may stand in for all of them.

1. **Filesystem containment** — readable and writable roots, mandatory denies, and
   symlink-safe path handling.
2. **Process isolation** — whether the workload shares the user's kernel, user, and
   process namespace or has a stronger container/VM boundary.
3. **Network mediation** — whether direct sockets are denied and allowed traffic is
   scoped per execution.
4. **Secret mediation** — whether raw credentials enter the workload or are attached
   by a trusted broker.
5. **Lifecycle isolation** — who owns create, start, cancel, reap, restore, and
   teardown, including what survives an app or host crash.
6. **Persistence isolation** — where thread state, workspace state, logs, and
   checkpoints live, and which are encrypted or user-owned.

The UI and audit record must describe reduced-capability runtimes honestly. An
approval gate without an OS/runtime boundary is still useful, but it is not equivalent
to enforced containment.

## Binding decisions

1. **A logical session is separate from its runtime.** A Copse thread owns durable
   conversation and execution metadata. The process, container, VM, or provider
   session running work for it is replaceable and disposable.
2. **One runtime contract covers local and remote execution.** `ExecutionTarget`
   remains the routing input; an `ExecutionRuntime` layer owns lifecycle, execution,
   capabilities, and observations. SSH is a transport adapter, not a claim of remote
   containment.
3. **Approval grants a capability; it does not silently remove unrelated controls.**
   A grant names the execution owner, operation, filesystem scope, network
   destination, duration, and whether it is one-shot or remembered. Fully
   unsandboxed host execution remains an explicit last tier.
4. **Network access is fail-closed and per execution.** A contained process has no
   direct egress. Approved traffic goes through a broker enforcing destination,
   protocol, port, operation, expiry, and redirect policy. A process-global allow-list
   is a compatibility constraint, not the target model.
5. **Raw credentials stay outside untrusted workloads by default.** The main process
   or a trusted host-side broker owns credential lookup and lifecycle. The broker
   attaches a credential only to an authorized request and records use by opaque
   credential identity, never by value. Any temporary raw-secret injection must be
   named as a reduced guarantee, scoped, short-lived, and removed after use.
6. **Policy decisions and observed effects are canonical events.** Runtime state,
   approvals, process start/exit, network allow/deny, credential use, checkpoints,
   restores, and teardown append to the thread spine. Optional hooks may subscribe;
   they are not the only persistence path.
7. **Portable checkpoints come first.** The baseline checkpoint is a thread-spine
   position plus a Git/workspace snapshot and runtime metadata. A backend may add a
   full process or VM snapshot, but resume and rollback must not require that
   capability.
8. **Provisioned cloud workspaces reuse the SSH workspace tool surface.**
   Provisioning, policy, and lifecycle sit below it. We do not build a parallel set of
   file, shell, git, terminal, and search tools for cloud containers.
9. **Managed remote agents are provider trust boundaries.** Copse can minimize what it
   sends, request the narrowest available provider policy, and record the handoff. It
   cannot claim local-runtime enforcement for a provider-managed guest.
10. **Classifiers never grant authority.** Static or model-based classification can
    route, explain, or hard-deny. Enforcement and explicit grants remain the security
    boundary.

Changing one of these decisions requires updating this document in the same change.

## Target contracts

The exact TypeScript belongs to the implementation phase, but the contract must carry
at least this information:

```ts
interface ExecutionRuntimeCapabilities {
  filesystem: 'workspace' | 'host' | 'remote-account'
  processIsolation: 'none' | 'os-sandbox' | 'container' | 'vm' | 'provider-managed'
  network: 'none' | 'global-allowlist' | 'per-execution-broker' | 'unrestricted'
  secrets: 'raw-env' | 'scoped-injection' | 'brokered'
  checkpoint: 'none' | 'workspace' | 'full'
  suspendResume: boolean
}

interface ExecutionGrant {
  projectId: string
  threadId: string
  turnId: string
  operation: string
  filesystem?: { read?: string[]; write?: string[] }
  network?: { origins: string[]; methods?: string[]; ports?: number[] }
  credentialRef?: string
  expiresAt: number
  remembered: boolean
}

interface ExecutionRuntime {
  capabilities(): ExecutionRuntimeCapabilities
  create(): Promise<RuntimeHandle>
  exec(request: ExecRequest): Promise<ExecHandle>
  inspect(): Promise<RuntimeObservation>
  checkpoint(): Promise<CheckpointRef>
  suspend(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}
```

Runtime implementations must be idempotent at their lifecycle boundary. Repeating
`stop`, reconciling after a crash, or receiving a duplicate create response must
converge to one observable state.

## Lifecycle and persistence

The durable state machine is intentionally smaller than provider- or backend-specific
states:

```text
creating -> running -> idle -> suspending -> suspended -> restoring -> running
    |          |        |          |             |             |
    +----------+--------+----------+-------------+-------------+-> stopping -> stopped
                                      any state -----------------> failed
```

- `desiredState` is persisted with the thread/runtime link.
- `observedState` and the last successful reconciliation are recorded separately.
- Partial checkpoint upload never becomes restorable: a checkpoint is published only
  after every required artifact is durable and integrity-checked.
- Closing Copse does not imply a remote runtime stopped. App startup reconciles tagged
  resources and asks about or tears down orphans according to the recorded policy.
- Provider-managed sessions use the same logical states where observable, but retain a
  capability marker showing that teardown and storage semantics are provider-owned.

## Network and credential broker

The first vertical slice should be GitHub because Copse already has local API/CLI,
SSH-workspace, and managed-agent GitHub paths.

1. A child receives no raw GitHub token.
2. Direct egress is denied by the runtime where enforcement exists.
3. The child or tool talks to a local/host-side broker using an unforgeable,
   execution-scoped capability.
4. The broker validates origin, operation/method, redirect target, expiry, and rate
   limits, then attaches the credential.
5. The spine records the grant, destination, operation, response status, and bytes
   transferred within safe caps. It never stores authorization headers or secret
   values.

Package registries and cloud CLIs can follow once the GitHub path proves the model.
Generic open-proxy behavior is explicitly out of scope.

For provisioned cloud runtimes, deny cloud-instance metadata endpoints and private
network ranges by default. Control-plane, artifact, Git, package, and model origins are
separate grants; allowing one must not imply the others.

## Canonical audit events

The thread spine should gain versioned events for:

- `permission_decision` — proposed operation, pure-policy verdict, reasons, and
  decision owner;
- `execution_grant` — exact approved scope and expiry;
- `runtime_state` — desired/observed transition, runtime kind, and capability snapshot;
- `process_run` — canonical tool-call reference or redacted argv/command identity,
  cwd, start/exit, and bounded output refs;
- `network_access` — allowed or denied destination and matched grant;
- `credential_use` — opaque credential ref, destination, operation, and outcome;
- `checkpoint` — parent, artifacts, hashes, completeness, and retention;
- `restore` — selected checkpoint and terminal outcome;
- `runtime_teardown` — explicit, TTL, idle, reconciliation, or failure reason.

Hash chaining can make later edits detectable, but event completeness and independent
observation come first. These records contain sensitive project metadata and remain
local by default.

## Phases

### R0 — document and test today's boundaries

- Keep `docs/threat-model.md` aligned with the filesystem-native thread store and every
  execution surface.
- Add a capability matrix fixture for local macOS, local without an OS sandbox, SSH,
  managed remote agents, remote e2e, and the proposed cloud runtime.
- Add secret-canary tests showing which environment values reach each child type.
- Add direct-egress and cross-workspace negative tests where enforcement exists.

Exit gate: documentation and tests never call SSH or managed-agent execution
"sandboxed" without naming who enforces which property.

### R1 — runtime contract and always-on audit

- Introduce the capability and grant types through `ThreadExecutionContext`.
- Wrap existing local and SSH spawn paths behind an `ExecutionRuntime` adapter without
  behavior changes.
- Record permission decisions, runtime state, and process identity directly in the
  thread spine.
- Make the approval prompt display the runtime and properties the grant changes.

Exit gate: one conformance suite drives local and SSH adapters, and a thread export can
answer which runtime executed every recorded process.

### R2 — brokered local egress and credentials

- Implement a per-execution broker and GitHub vertical slice.
- Remove the selected GitHub token from the relevant child environment.
- Enforce redirect, alternate-origin, direct-socket, expiry, and concurrent-session
  isolation tests.
- Preserve a separately labelled, explicit full-host escape for operations the broker
  cannot support.

Exit gate: a secret canary is absent from the workload, approved GitHub work succeeds,
and the same process cannot reach an unapproved origin or reuse another thread's grant.

### R3 — enforceable local profiles on every supported platform

- Keep macOS ASRT as one adapter and remove process-global networking from the target
  contract once the broker can replace it.
- Add a maintained Linux containment backend with workspace-scoped mounts, reduced
  process privilege, and broker-only network.
- Design and ship a supported Windows boundary before claiming parity.
- Reintroduce `container`/stronger-isolation settings only after a real backend exists.

Exit gate: platform-matrix tests prove writable-root, home-read, process, and network
denies at the runtime boundary; unsupported properties are visible in the UI.

### R4 — Copse-provisioned cloud runtime

- Implement the provisioning lifecycle in `copse-cloud-workspaces.md`, starting with
  local Docker and then a cloud provider.
- Use an unprivileged workload, read-only base image, dedicated writable volume, TTL,
  idle reap, and startup reconciliation.
- Default to broker-only egress; never use unrestricted networking as the production
  profile.
- Keep provider, Git, registry, and LLM credentials outside the guest wherever the
  provider/runtime permits.

Exit gate: teardown is idempotent, an orphan is detected after restart, metadata/private
network egress is denied, and no long-lived credential is present in the guest image,
filesystem, environment, or checkpoint.

### R5 — checkpoints, suspend/resume, rollback, and fork

- Define the portable checkpoint manifest from thread-spine position, workspace
  snapshot, runtime metadata, and optional backend artifacts.
- Add rollback and crash recovery before user-visible forking.
- Add suspend/resume to backends that can support it without weakening isolation.
- Make retention tiered and bounded; restore only complete, integrity-checked snapshots.

Exit gate: killing Copse or the runtime during every lifecycle transition converges to
one recoverable or terminal state without corrupting the workspace.

### R6 — efficiency after invariants

- Measure create, exec, suspend, restore, and teardown latency by backend.
- Add warm images/pools, copy-on-write storage, and delta snapshots only behind the
  same conformance and isolation tests.
- Treat performance optimizations that share hosts, images, caches, or extents as
  security-relevant changes.

## Non-goals

- Choosing one VM or container product for every platform.
- Moving the provider-neutral model loop to the cloud by default.
- Treating a Git worktree or Docker container alone as a hostile-workload boundary.
- Promising customer-managed encryption keys for local-only data. That becomes relevant
  only if Copse stores durable user artifacts in Copse-controlled cloud storage.
- Replacing the readable filesystem-native thread store with a database-only source of
  truth.

## Relationship to existing plans

- [`command-sandboxing-routing.md`](command-sandboxing-routing.md) retains the shipped
  trusted-command design; its real-container follow-up is implemented here.
- [`ssh-remote-repo.md`](ssh-remote-repo.md) owns the shipped SSH workspace transport
  and tool surface. This plan supplies capability reporting, policy, and lifecycle
  above/below that transport.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) owns product provisioning,
  cost UX, and provider rollout; it must satisfy R4's security gates.
- [`remote-e2e-dev-loop.md`](remote-e2e-dev-loop.md) remains developer tooling and a
  useful disposable-runtime testbed, not the product runtime contract.
- [`thread-worktrees.md`](thread-worktrees.md) owns checkout allocation and execution
  ownership. Worktree isolation is complementary to, not a substitute for, runtime
  isolation.
- [`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md) remains
  comparative evidence; this document owns Copse's implementation decisions.
- [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) remains binding for hook
  sandboxing and permission-event integration. An audit subscriber must not become the
  only persistence path for canonical runtime events.
