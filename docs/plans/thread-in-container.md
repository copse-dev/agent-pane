# Running a thread inside a container

**Status: Active (prototype on the branch).** A thread can be run unattended inside a
disposable, hardened local Docker container with no user prompts: the product's own headless
agent loop runs in the guest, contained effects run without asking, outward effects are queued
for review, and the result comes back to the host as commits under `refs/copse/runs/<id>`.
The prototype is exercised end to end by
`src/main/services/container-runtime/thread-container.integration.test.ts` (opt-in, needs
Docker), driven by `pnpm run thread:container`, and started from the app through the composer
footer ("Run unattended in a container…"). What it does **not** yet do
is listed under [What the prototype proves, and what it does not](#what-the-prototype-proves-and-what-it-does-not).

This plan is the executable slice of two documents that were design-only:
[`unattended-runs.md`](unattended-runs.md) (the product question: what changes about asking
the user when nobody is watching and the runtime is disposable) and the remote-worker
assessment this plan was based on (the harness is already portable; what is missing is
ownership, not de-Electroning). It records where the prototype **diverges** from the
unattended-runs decisions and why, so those decisions can be revised in one place rather than
silently contradicted.

## The starting point

Three things were already true on `main` and made this cheap:

1. **The run path has no Electron dependency.** `src/main/services/headless-agent-host.ts`
   builds the real registry, tools, hooks, supervisor and permission policy from an explicit
   profile with no renderer or IPC. The autonomy eval already runs it inside Docker for hours
   unattended (`benchmarks/autonomy/Dockerfile`, `scripts/autonomy-regression-agent.mts`).
2. **The non-blocking outcome exists.** Deferred approvals D0–D1 landed: `requestApproval` is
   the one seam every gate funnels through, and with a thread in deferral mode it queues the
   request and throws `DeferredApprovalError` instead of opening a modal
   (`src/main/services/approval.ts`, `security/deferral-mode.ts`, `deferred-approval-store.ts`).
3. **Linux containment exists.** Bubblewrap through the sandbox runtime is the Linux project
   sandbox, and it initialises inside a container once Docker's default seccomp profile is
   relaxed to allow user namespaces.

What was missing was the thing between them: a runtime the gate could _trust_ as a
containment boundary, and a gate rule that answers by blast radius instead of by "would a host
sandbox have contained this?".

## Design

```text
host                                                 guest (docker, --network none)
────────────────────────────────────────────────     ──────────────────────────────────────────
run dir  ~/.copse/runtimes/<id>/                     /run/copse (ro)
  run.json, attestation.json  ──────────────────▶      read by the worker
  carry-in.bundle (snapshot commit) ────────────▶      git fetch → /workspace/repo (tmpfs)
  egress/<host>_<port>.sock  ◀── EgressBroker          socat 127.0.0.1:<port> → sock
  state/  (COPSE_DIR: decision log, deferred queue) ◀  written by the gate
  out/    result.json, messages.json, carry-out.bundle ◀ written at the end
record.json (review record)                           worker.cjs: runHeadlessAgent(...)
git fetch carry-out → refs/copse/runs/<id>               + declareContainerRuntime(attestation)
                                                         + armUnattendedRun(thread, budgets)
```

- **The guest runs the loop.** `src/main/services/container-runtime/worker-entry.ts` is
  bundled as a standalone main bundle (`dist/main/thread-container-worker.cjs`) and started
  by the image entrypoint as an unprivileged user. It carries the workspace in,
  declares its containment from the host's attestation, arms an unattended run on the thread,
  and calls `runHeadlessAgent` with a fail-closed approval handler that counts every prompt
  it sees. The count is part of the result and the end-to-end test asserts it is zero.
- **The host attests; the guest declares.** A guest cannot verify its own boundary. The host
  writes `attestation.json` from the same `dockerRunArgs` it starts the container with
  (`src/main/services/container-runtime/thread-container.ts`), and `declareContainerRuntime`
  (`security/runtime-containment.ts`) refuses anything short of the bar: unprivileged uid,
  read-only rootfs, `cap-drop=ALL`, `no-new-privileges`, no network beyond the broker, no
  host mount outside `/run/copse`. A refused declaration leaves the worker on the desktop
  rules, which prompt — and, in deferral mode, queue — so the failure is loss of
  productivity, never loss of containment.
- **The gate answers by blast radius.** `ensureShellCommandPermitted` takes one new branch
  before everything else when the run is an unattended run _and_ the runtime declared
  `container`: the harm gate still runs (its hard denies stay hard), then
  `decideContainedShellEffect` (`@copse/shell-guard/container-effects.ts`) refuses host
  escapes, defers outward effects, and allows everything else — including the harm gate's
  _prompt_ verdicts, which are all in-guest destructive shapes that `docker rm` undoes. A
  deferral goes through the ordinary approval seam under the new prompt cause
  `shell-outward-effect`, so the queue, the decision log and the D0 report all see it.
- **Two ledgers, mutually exclusive.** `UnattendedRunRegistry`
  (`security/unattended-run.ts`) is beside `GuardedYoloRegistry`, session-only, per-thread,
  never in settings. Arming refuses a thread with Guarded YOLO armed or active and vice
  versa, and arming begins deferral mode in the same call so a gate can never see one
  without the other. The gate consults the runtime _and_ the ledger; a matrix test
  enumerates command class × tier × unattended state.
- **Egress is deny-by-default and named.** The container has no network interface. For each
  allowlisted `host:port`, the host binds that name to loopback inside the guest
  (`--add-host`), a `socat` listener forwards the port into a unix socket the host mounts
  at `/run/copse/egress`, and the host-side `EgressBroker` dials the real origin and
  records every connection with byte counts. The guest cannot name a destination; it can
  only reach a socket the host already created. (`--resolve host=addr` lets the host dial a
  different address for a name only the guest resolves, which is how a local model server
  is reached in the tests.)
- **No credentials in the guest except one.** The model loop needs a provider key, so the
  worker receives exactly that value in its environment, consumes it into the provider
  client, and blanks the variable before any tool can spawn a child. Git remotes, GitHub
  tokens and the host's environment never enter. A secret canary exported on the host is
  checked against every host-owned surface of the run and against the guest's reported
  environment key names.
- **Carry-in and carry-out are git bundles.** The host snapshots the working tree (staged,
  unstaged, untracked; `.gitignore` respected) into a commit without moving HEAD, bundles it
  under a run-scoped ref, and the guest fetches it onto a `work` branch. At the end the
  worker commits anything left uncommitted, bundles `carryInBase..work`, and the host
  fetches that into `refs/copse/runs/<id>`. The host's HEAD never moves and nothing is ever
  pushed by the run.
- **Budgets end runs; modals do not.** Wall-clock and token ceilings are mandatory at arm
  time. The worker aborts its own loop at the ceiling and records the reason; the host stops
  the container at the wall-clock budget as a backstop. Teardown is idempotent.
- **Every run leaves a record.** `record.json` carries the image and digest, the attestation,
  the egress log, the guest's result (stop reason, prompts attempted, deferrals, commits,
  containment actually achieved, tokens), the carry-out ref, the container exit code, the
  teardown outcome and the canary check.

## From the app

The composer footer's overflow menu has **Run unattended in a container…**
(`src/renderer/views/container-run-control.ts`). The dialog it opens has two faces: before a
run it is the arming form — the composer draft as the task, the wall-clock and token budgets,
and a note of the model and the single origin the guest will be able to reach — and during
and after a run it is the status view: phase, log tail, and the review record (what was
deferred, what was committed and on which ref, what the guest could reach, the canary check,
the teardown). A banner over the composer mirrors the phase while the dialog is closed, and a
toast announces the end of the run.

The renderer sends a prompt, a model id and two numbers over `container:runThread`; the main
process (`container-runtime/container-run-service.ts`) resolves the checkout, the provider
(`providers/container-provider.ts`: local servers, OpenAI, OpenRouter and extra providers
through the guest's OpenAI-compatible client; Anthropic through the product's own resolver
inside the guest) and the key, builds the worker image on first use from the bundle the
build emits and the sandbox runtime copied from the app's own `node_modules`, and pushes
`ContainerRunProgress` snapshots over `container:runChanged`. Arming is written to the
thread's decision log under `mode-arming`, like Guarded YOLO, and a thread can have only one
live run.

## Where this diverges from `unattended-runs.md`

The unattended-runs plan was written for **Lever A on the desktop**: the loop stays on the
laptop, the container is an SSH target for the tools. This prototype runs the **loop in the
guest**. The trade is deliberate and is the one the remote-worker assessment recommends: a
loop that lives on the desktop dies when the laptop closes, and every unattended scenario the
long-horizon plans want is exactly the one where it does.

| `unattended-runs.md` decision                        | Here                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — container is an SSH host, not a new tool surface | Neither: the container runs the whole headless host, so the tool surface is the product's own, unchanged. No second transport was built. SSH is not involved in v1; it returns when the desktop attaches to a running guest. |
| 2 — provenance decides capabilities                  | Kept, as an _attestation_: the host records the hardening it applied; the guest declares from that record and refuses a short one.                                                                                           |
| 3 — no credentials in the guest                      | **Narrowed**, not kept: exactly one credential — the provider key — is in the guest, by value, for the run, and blanked from the environment before any child spawns. Everything else stays out.                             |
| 4 — egress deny-by-default and named                 | Kept and made structural: no interface at all; named origins only through the broker.                                                                                                                                        |
| 5 — separate concept from Guarded YOLO               | Kept: separate ledger, separate arming, mutually exclusive, tested both ways.                                                                                                                                                |
| 6 — the gate never blocks                            | Kept: arming implies deferral mode; the fail-closed handler in the worker counts what would have blocked and the test requires zero.                                                                                         |
| 7 — budgets mandatory                                | Kept: refused without them; enforced in the guest and backstopped by the host.                                                                                                                                               |
| 8 — every run produces a review record               | Kept as `record.json`; not yet written to the thread spine as canonical events.                                                                                                                                              |
| 9 — not a hostile-workload boundary                  | Kept, and sharper: the guest runs with `seccomp=unconfined` so bubblewrap can create namespaces. The container is the user's own disposable machine, not a multi-tenant claim.                                               |
| 10 — classifiers never grant authority               | Kept: `decideContainedShellEffect` routes; the grant is the explicitly armed run on an attested runtime.                                                                                                                     |

If the loop-in-guest direction is confirmed, decisions 1 and 3 in `unattended-runs.md` should
be revised to say so. Until then that document is unchanged and this one records the
divergence.

## What the prototype proves, and what it does not

**Proven** (by `thread-container.integration.test.ts` against a real Docker daemon, with a
scripted OpenAI-compatible model behind the broker driving the real provider client, tool
dispatch, gate, deferral queue and carry-out):

- a whole thread completes in the guest with **zero prompts** reaching a handler;
- an in-guest destructive command (`rm -rf build …`) that the harm gate would have prompted
  for runs without asking;
- `git push` is **deferred**: queued under `shell-outward-effect` in the run's own
  `deferred-approvals.jsonl`, reported to the agent as not-run, never executed;
- `docker ps` is **refused** as a host escape;
- the agent's commits and its uncommitted leftovers come back under `refs/copse/runs/<id>`
  while the host's HEAD and index are untouched;
- the only connections out of the guest are to the one allowlisted origin, and the broker
  logged each;
- the host's secret canary is absent from every host-owned surface and from the guest's
  environment;
- teardown removes the container, removing it again reports `already-gone`, and the
  managed-container sweep no longer lists it.

**Not proven, and required before this is a product:**

- **A real model.** The scripted server proves the plumbing; a real provider behind the
  broker (`--allow api.openai.com:443` with `--api-key-env`) has been designed but not run
  here — this sandbox has no provider credential. The broker forwards raw TCP so TLS is
  end-to-end; the guest needs the origin's port bound on loopback, which
  `--sysctl net.ipv4.ip_unprivileged_port_start=0` provides for 443.
- **Replaying a deferral from the dialog.** The record lists what is waiting, but approving
  it (the host-side push) still needs deferred-approvals D2.
- **Attaching from the desktop.** The run is fire-and-collect. The assessment's route —
  Copse's ACP agent role in the guest, the desktop attaching over ACP with session resume,
  a fenced per-thread lease — is the next slice, not this one. Until then the desktop
  reads the record and the ref, not a live transcript.
- **Review surface.** Deferrals are in the queue and the record, with no UI to approve and
  replay them (deferred-approvals D2). Approving a deferred `git push` is a host-side action
  by design and needs that surface.
- **Canonical spine events.** The record is a JSON file per run, not `runtime_state` /
  `network_access` events on the thread spine as `execution-runtime-security.md` wants.
- **Orphan reconciliation at app start.** The sweep exists (`--list`, `--teardown`) and is
  tested, but nothing runs it on startup; there is no TTL label on the container yet, so a
  crashed host leaves a stopped container until the sweep is invoked.
- **Image freshness and dependency bake.** The image carries the toolchain only; the
  project's dependencies install inside the guest on each run. The lockhash-gated bake from
  `remote-e2e` is the obvious next step and changes what "long-horizon" costs on macOS.
- **U0's measurement.** Whether a container actually removes most prompts on real long runs
  is still the empirical question `unattended-runs.md` asks first. This prototype makes the
  experiment runnable; it does not answer it.

## Known implementation traps

Recorded because each cost time and will again.

- **bubblewrap inside Docker needs `seccomp=unconfined`.** Docker's default profile refuses
  `unshare`, so ASRT's Linux backend fails to initialise with the misleading "kernel does
  not allow non-privileged user namespaces". `apparmor=unconfined` and
  `systempaths=unconfined` follow for the same reason. The autonomy eval already makes this
  trade; the attestation does not claim a syscall filter at the container boundary.
- **`# syntax=docker/dockerfile:1` pulls a frontend image from Docker Hub.** In a sandbox
  where Hub is rate-limited or blocked the build fails before reading line 2. Leave it out.
- **`git fetch` into the checked-out branch is refused, even an unborn one.** The guest
  initialises on a placeholder branch and fetches into `work`, then checks it out.
- **The sandbox runtime is not bundleable.** `@anthropic-ai/sandbox-runtime` resolves helper
  files by path at run time, so it stays external and is installed into the image at the
  version pinned in the lockfile. `node-pty` is aliased to a throwing stub: the worker
  offers no PTY, and a missing native module at load time would otherwise stop the bundle.
- **Unix socket paths are short, and a profile path is not.** `sun_path` is 104–108 bytes;
  `~/Library/Application Support/…/runtimes/<id>/egress/<host>_<port>.sock` is longer and
  the failure is a hang rather than an error. The broker refuses a path over 100 bytes and
  the sockets live under the system temp root (`copse-egress-<id>`), mounted into the guest
  from there, with an empty `egress` directory kept in the run dir purely as the mountpoint
  the read-only bind cannot create.
- **Unix-socket egress is Linux-hosted.** Docker Desktop on macOS does not share unix
  sockets across the VM boundary. The broker abstraction is what changes for macOS (a
  loopback TCP listener on the host reached through `host.docker.internal`), not the guest
  side; that variant is not built.
- **`git add -A` fails inside a bubblewrap-contained process.** The Linux sandbox
  materialises its mandatory write-deny paths (`.bash_profile`, `.vscode`, …) as mount
  points in the checkout for the life of the sandboxed process
  ([`linux-sandbox-rollout-followups.md`](linux-sandbox-rollout-followups.md) §0), and git
  refuses to add a mount point. This is a pre-existing Linux limitation, not a container
  one, and it also affects the `git_commit` tool's `stage_all`. Adding explicit paths works;
  the worker's own end-of-run snapshot runs after the sandbox is shut down and is unaffected.
- **The guest's uid is not the host's.** The `state`, `out` and `egress` directories under
  the run directory are created world-writable so an unprivileged guest uid can write them.
  They are per-run and under the user's own profile; a user-namespace remap is the cleaner
  answer and is not built.
- **Some sandboxes cannot reach Docker Hub or Debian's archive.** The image takes
  `--base-image` and `--build-network` (and the matching `COPSE_WORKER_*` variables) so a
  mirror or a locally built base can substitute without editing the Dockerfile.

## Phases

- **T0 ✅ — prototype on the branch.** Everything above. Exit gate: the end-to-end test
  passes against a real daemon, and `pnpm run check` is green.
- **T1 — real provider and a real grind.** Run the container against a real model with the
  broker allowlisting only the provider origin; run one lint- or type-backlog task from
  `long-horizon-tasks.md` end to end; report prompts removed vs deferred with the D0 report
  over the run's own decision log. This is the U0 experiment, now runnable.
- **T2 — attach and hand back.** Copse's ACP agent role as the guest entry, session resume
  advertised, the desktop attaching over the run's own channel, and the per-thread writer
  lease from `acp-session-continuity.md` so desktop and guest never both advance a turn.
  Exit gate: close the desktop mid-run, reopen, and observe one converged thread.
- **T3 — review surface and host-side replay.** Deferred-approvals D2 over this queue:
  approve replays the exact request on the host (the push happens from the host's checkout
  of `refs/copse/runs/<id>`, never from the guest); reject informs the next turn.
- **T4 — lifecycle and record hardening.** TTL label and startup reconciliation; canonical
  spine events for runtime state, egress and teardown; dependency bake gated by lockhash;
  the macOS broker variant.

## Test plan

| Area                   | Tier        | What it proves                                                                                               | Where                                                    |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Effect classification  | unit        | Host escapes deny; outward effects defer; in-guest destruction allows; harm denies stay denies               | `packages/shell-guard/src/container-effects.test.ts`     |
| Attestation            | unit        | Every shortfall (root, writable rootfs, caps, privileges, foreign mount) refuses the declaration             | `security/unattended-run.test.ts`                        |
| Ledger                 | unit        | Arming implies deferral mode; mutually exclusive with Guarded YOLO both ways; budgets required               | `security/unattended-run.test.ts`                        |
| Gate matrix            | unit        | Command class × containment tier × unattended → exact outcome, including the desktop-tier and not-armed rows | `security/unattended-run.test.ts`                        |
| Docker argv and record | unit        | The flags the attestation claims are the flags used; only the run dir is mounted; key passed by name         | `container-runtime/thread-container.test.ts`             |
| Carry-in / carry-out   | unit (git)  | Dirty tree snapshots without moving HEAD; guest commits round-trip to `refs/copse/runs/<id>`                 | `container-runtime/thread-container.test.ts`             |
| End to end             | integration | The eight properties listed above, against a real daemon, opt-in via `COPSE_THREAD_CONTAINER_E2E=1`          | `container-runtime/thread-container.integration.test.ts` |
| Provider plan          | unit        | Model id → endpoint, key and the one egress origin; cloud models without a key are refused before Docker     | `providers/container-provider.test.ts`                   |
| Run service            | unit        | Provider resolved, key passed by env var and blanked once the guest holds it, phases published, refusals     | `container-runtime/container-run-service.test.ts`        |
| UI (browser tier)      | demo        | Footer action, arming form with the draft prefilled, banner and review record for a finished run             | `tests/demo/container-run.demo.ts`                       |
| UI (Electron)          | e2e         | Real IPC: the dialog opens from the footer and a model without a key is refused with a readable error        | `tests/e2e/container-run-dialog.e2e.ts`                  |

## Non-goals

- A hostile-workload or multi-tenant boundary. The guest is the user's own disposable
  machine, started by their own daemon, and the UI must say so.
- A second permission vocabulary, transport, queue or scheduler. The gate gained one branch
  and one prompt cause; the queue, the decision log and the headless host are the existing
  ones.
- Auto-approving anything whose effect leaves the guest.
- Changing Guarded YOLO, which keeps its meaning and its own ledger.
- Cloud provisioning, checkpoints, suspend/resume — `copse-cloud-workspaces.md` and
  `execution-runtime-security.md` own those and this runtime should be a clean consumer.

## Relationship to existing plans

- [`unattended-runs.md`](unattended-runs.md) owns the product argument and the decisions
  this plan is measured against; the divergence table above is the reconciliation.
- [`deferred-approvals.md`](deferred-approvals.md) owns the `defer` outcome this plan
  consumes unchanged, and the review surface (D2) this plan needs next.
- [`execution-runtime-security.md`](execution-runtime-security.md) owns the capability,
  egress, credential and audit contracts. The attestation is its capability record made
  concrete for one runtime; the record file should become its spine events.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) owns provisioning providers. The
  local-docker path here is its C1 with the loop inside; a cloud host is the same runner
  behind an SSH hop.
- [`acp-session-continuity.md`](acp-session-continuity.md) owns the resume and lease
  semantics T2 depends on.
- [`long-horizon-tasks.md`](long-horizon-tasks.md) supplies the grind corpus for T1.
