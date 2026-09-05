# Offloading the harness to another device

**Status: Proposed.** Nothing here is implemented. This plan answers one question the
package extraction made worth asking: now that the agent runtime no longer needs Electron,
what stops it running on a different machine from the window that started it?

The target scenario, stated plainly: the desktop stays in charge, a second machine runs the
harness, and **closing the laptop does not end the run**. On a trusted host that run may be
unattended — Guarded YOLO for what the harm gate allows, deferral for what it does not.

## Why this plan exists

Every existing remoting plan stops short of this on purpose, and each stops at a different
place:

- [`ssh-remote-repo.md`](ssh-remote-repo.md) moved the **tools**. File tree, file tools,
  shell, terminal, git and search all operate on the remote host while "the LLM loop,
  approvals, thread store, and UI stay local". It explicitly rejected a remote server
  component for v1, which is exactly what forecloses detachment.
- [`acp-over-ssh.md`](acp-over-ssh.md) puts _an_ agent loop on the remote host, but it is an
  external vendor agent and Copse remains the client. Dropping the SSH connection kills the
  remote process group by design.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) names the end state (C7, a
  detached worker) and correctly refuses to call a provisioned container "device
  independence" without it.
- [`mobile-web-experience.md`](mobile-web-experience.md) declares device independence a
  non-goal: "The laptop must be awake with Copse running; when it sleeps, the page dies."
- [`remote-agents.md`](../remote-agents.md) is the only shipped path where the laptop can
  close — because the run belongs to Cursor or Anthropic, not to Copse. Right shape, wrong
  owner.

So the capability has been consistently deferred rather than designed. What changed is that
the reason for deferring it — "the runtime is welded to the app" — is no longer true.

## What the extraction actually bought

This is not aspiration; it is measurable on `main` today.

| Fact                                                  | Evidence                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent runtime does not need Electron              | 30 of 476 non-test files in `src/main` name `electron`, 13 of those for types only, so 17 import it at runtime — and none are on the agent, tool, hook, sandbox or thread-store path. [`library-splits.md`](library-splits.md) counts the same 30 for its client/server row |
| A headless host already runs the _whole product loop_ | `src/main/services/headless-agent-host.ts` builds the real registry, skills, MCP, hooks, supervisor and permission policy from an explicit profile, with no renderer and no IPC                                                                                             |
| That claim is enforced, not asserted                  | `scripts/verify-agent-path-import.mts` bundles the registry, system prompt and headless host for plain Node and constructs them with `electron` poisoned; `scripts/module-boundaries.test.ts` holds `packages ↛ src`                                                        |
| The main process already runs as plain Node           | The Tauri sidecar (`src/sidecar/`) runs `src/main/index.ts` byte-identical against an `electron` shim, with IPC over a loopback WebSocket                                                                                                                                   |
| The wire format is already written                    | `packages/agent/src/headless-contract.ts` fixes the request/event envelope, resume and fork, stop reasons, and one permission vocabulary that fails `ask` **closed** with no interactive approver                                                                           |
| Linux has an enforcing sandbox                        | bubblewrap via ASRT, [#1440](https://github.com/copse-dev/agent-pane/pull/1440)–[#1442](https://github.com/copse-dev/agent-pane/pull/1442); `isProjectSandboxEnabled()` is a capability question, not a platform one                                                        |

Every seam a remote host would need to rebind is already an injection point:
`AgentHost.emit`, the approval / ask-user / SSH-prompt / staged-diff handlers, the shell
output sink, `SecretCipher`, `ElectronAppRuntime`, and `configureThreadStore`.

The honest qualification: **no main-process code drives any of this.** The only non-test
caller of `runHeadlessAgent` is `scripts/autonomy-regression-agent.mts`. The runtime is
portable and unused.

## Where execution runs today

| Piece                           | Local   | SSH workspace | ACP over SSH           | Managed / Cursor agents |
| ------------------------------- | ------- | ------------- | ---------------------- | ----------------------- |
| Agent loop                      | desktop | desktop       | remote (foreign agent) | provider                |
| Shell, fs, git, search          | desktop | remote        | remote                 | provider                |
| Permission gate, diff queue     | desktop | desktop       | desktop                | provider                |
| Thread store                    | desktop | desktop       | desktop                | provider (reattachable) |
| Provider credentials            | desktop | desktop       | agent's own            | provider                |
| **Survives the laptop closing** | no      | no            | no                     | yes                     |

## The premise, corrected

The instinct is that offloading is a transport problem. It is not: SSH already carries the
tool layer, and the loop is already portable. Offloading is an **ownership** problem.

Exactly one process may advance a thread's turn and append to its spine. Today that
invariant is upheld by there being only one process. The thread store's mutual exclusion is
an in-process mutex (`runSerialized`), **not** a file lock — two processes over one
`~/.copse/workspace` have no mutual exclusion at all. So the first thing to build is not a
daemon; it is a lease.

The second correction: "the desktop stays in charge" and "the remote keeps running" are only
compatible if _in charge_ means holding policy and the right to revoke, not holding the
turn. A desktop that must be reachable for the run to proceed has not offloaded anything.

## Binding decisions

1. **The worker is a Copse process, not a foreign agent.** It runs the same
   `runHeadlessAgent` stack over the headless contract. This is what separates the plan from
   `acp-over-ssh.md` (someone else's loop) and `managed-agent-environments.md` (someone
   else's runtime).
2. **Ownership is a fenced, per-thread writer lease** with an owner id, a monotonic epoch, and
   a heartbeat, stored beside the thread. A process that does not hold the lease may read and
   stream but must refuse to advance a turn or append to the spine. Presence heartbeats
   without fencing are insufficient — this is `copse-cloud-workspaces.md`'s split-brain risk
   and it is the whole ballgame.
3. **Detach is the normal case, not an error path.** The desktop disconnecting is an
   `attach`/`detach` on a run the worker owns. Connection loss must never terminate a run, and
   must never be inferred as consent to continue.
4. **The worker owns the transcript.** It appends to the spine, so a disconnected turn is
   complete when the desktop returns. Note this fixes a bug that exists locally today:
   closing the window mid-run loses that turn's transcript while the agent keeps running
   (`mobile-web-experience.md` L1).
5. **No new listening surface.** The worker channel travels over the SSH workspace's existing
   ControlMaster forward. The sidecar WebSocket bridge binds loopback and fabricates
   `event.senderFrame` so existing guards pass; pointing it at a network peer would expose the
   whole IPC handler table, which `mobile-web-experience.md` refuses for good reason.
6. **Unattended is a mode, not a policy.** Guarded YOLO covers what the harm gate allows;
   everything else resolves to `allow`, `deny`, or `defer`, never a modal nobody can answer.
   A run ends by budget, completion, or the user. Budgets are mandatory.
7. **YOLO requires proven containment.** The worker advertises its sandbox state and the
   desktop refuses to arm unattended mode without an enforcing backend. An unsandboxed remote
   in YOLO is total trust of that machine, and must be an explicit, per-host decision.
8. **Credentials are leased, not brokered.** The worker holds a short-lived provider key for
   the duration of its lease. A broker that needs the desktop online defeats the point. This
   knowingly departs from the "keys never leave the desktop" line held by
   `ssh-remote-repo.md` and `unattended-runs.md`; the alternative is not offloading.
9. **The worker runs under a non-human principal.** It must not inherit the ambient
   credentials or remembered approvals of whoever last opened the project
   (`execution-runtime-security.md` Decision 11). Takeover is an explicit lease transition.

## Phases

Each phase is independently useful and independently shippable. O0 and O1 are the ones that
do not already have a plan of their own.

### O0 — the worker entry

A Node entry that runs the headless host stack on a remote host: no Electron, no window, an
explicit profile. The sidecar's `electron` shim already proves the bundle builds; the verify
script already proves the import graph is clean.

The mechanism is not this plan's to invent. [`library-splits.md`](library-splits.md) step 9
([#2312](https://github.com/copse-dev/agent-pane/issues/2312)) owns the versioned API
protocol and the `ShellHost` interface for the files that reach for `BrowserWindow`,
`dialog` and `shell`, and the client/server split that follows from them. O0 is that split's
first consumer, not a second attempt at it: if #2312 lands first, O0 is a packaging step.

_Exit gate:_ a `copse-worker` bundle runs a real turn on a Linux host with bubblewrap active,
with `electron` absent from the bundle, and emits a valid headless-contract event stream.

### O1 — the writer lease

Fenced per-thread ownership in the thread store: acquire, heartbeat, expire, take over. The
desktop and the worker both honour it. Stale-owner recovery is specified by
`acp-session-continuity.md`'s writer lease; this generalises it beyond ACP.

_Exit gate:_ two processes race for one thread and exactly one advances it. Killing the owner
lets the other take over only after expiry. No duplicate provider turn, commit, or spine
append under a partition.

### O2 — attach, detach, reattach

The desktop streams a worker-owned run over the ControlMaster forward and detaches without
stopping it. Requires moving the chunk-to-message reducer into main
(`mobile-web-experience.md` L1) so the transcript survives the window.

_Exit gate:_ disconnect the desktop mid-turn, sleep the machine, reconnect. The transcript is
complete and the run converged exactly once.

### O3 — approvals with nobody watching

Guarded YOLO plus deferral mode on the worker; the deferred queue surfaces on the desktop when
it returns. D0–D1 of [`deferred-approvals.md`](deferred-approvals.md) are landed — the `defer`
outcome and its durable append-only queue exist. What is missing is D2's review surface and an
approver that is not the local UI.

_Exit gate:_ an unattended run never blocks on a modal. Every deferred request replays against
the same execution context or fails loudly when that context is gone.

### O4 — leased credentials and egress

Short-lived provider keys scoped to the lease; the worker's network scope declared and
enforced. `execution-runtime-security.md` R3 asks for broker-only egress on Linux, which
bubblewrap alone does not provide, so this phase inherits that gap rather than closing it.

### O5 — triggers while the desktop is away

The background supervisor already survives renderer close and app restart, reconciles on
startup, and fails closed when the execution target drifts from its snapshot. Run it on the
worker. Always-available ingress remains out of scope.

### O6 — take-back and hand-off

Move a live thread between desktop and worker, and between two workers, as a lease transition.

## Test plan

- Lease unit tests for acquire, expire, epoch fencing, and concurrent takeover.
- A partition test that severs the channel mid-turn and asserts exactly one converged run.
- The autonomy container harness, already used for unattended evals, extended to run against a
  worker rather than in-process.
- A sandbox-state test proving the desktop refuses to arm YOLO against a worker without an
  enforcing backend.
- No new e2e tier: the worker has no UI. Desktop-side attach and detach need focused visual
  evidence per `AGENTS.md`.

## Risks and open questions

- **Split-brain is the plan's central risk.** Everything else is recoverable; two loops
  advancing one thread is not.
- **Cross-process thread-store locking does not exist.** O1 must add it or the store is
  corrupt the first time both machines are awake.
- **A deferral queue nobody reads** is the failure mode of O3 — the same risk
  `deferred-approvals.md` names for itself.
- **Prompt injection over a long horizon** is materially worse with no human in the loop and a
  machine the user is not watching.
- **Open: does the worker need the repo, or a checkout of it?** Reusing the SSH workspace's
  remote root is the cheap answer and couples the worker to that host.
- **Open: what does the desktop show for a run it does not own?** `mission-control.md` is the
  natural home for the answer.

## Non-goals

- Multi-user or collaborative editing of one thread.
- Moving the loop to a Copse-operated cloud by default. The worker is a machine the user
  already has.
- Replacing managed agents. Provider-hosted runs stay a separate, supported path.
- A public listening service. Everything travels over SSH the user already configured.

## Relationship to existing plans

This plan is the missing middle, not a new stack. Its parent is
[`library-splits.md`](library-splits.md), which did the extraction that makes the question
worth asking and already owns the client/server split
([#2312](https://github.com/copse-dev/agent-pane/issues/2312)) that O0 consumes; this plan is
the product capability that split unlocks, and says nothing about how the packages are cut.
It also consumes `copse-cloud-workspaces.md` C7 (detached worker, lease, ownership transfer),
`deferred-approvals.md` D2 (a review surface an absent user can reach),
`unattended-runs.md` U2–U3 (the unattended mode and its budgets),
`acp-session-continuity.md` (writer lease and durable session binding),
`headless-automation-contract.md` Phase 4 (the CLI/worker surface the contract was written
for), `execution-runtime-security.md` (principal, grant, capability model), and
`mobile-web-experience.md` L1 (main-owned transcript). It supplies what none of them own: the
decision that the worker runs _Copse's_ loop, and the lease that makes handing it over safe.
