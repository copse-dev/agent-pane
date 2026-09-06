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
Agent-backed models (ACP) are offered greyed out; the route to running them is planned, not
built, under [Agent models in the guest (ACP)](#agent-models-in-the-guest-acp).

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
  egress/broker.sock  ◀── EgressBroker (allowlist)     127.0.0.1:3128 CONNECT proxy → sock
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
- **Egress is deny-by-default and named.** The container has no network interface. The
  host mounts one unix socket at `/run/copse/egress/broker.sock`; the worker starts an HTTP
  CONNECT proxy on its own loopback (`guest-egress-proxy.ts`) and every client in the
  guest is pointed at it through `HTTPS_PROXY`/`HTTP_PROXY` (Node's global `fetch` honours
  them under `NODE_USE_ENV_PROXY=1`). Each connection opens the socket and writes one line,
  `CONNECT host:port`; the host-side `EgressBroker` matches it against the run's allowlist
  — exact `host:port` entries and `*.suffix:port` wildcards (`egress-rules.ts`) — then
  answers `OK` and pipes bytes, or `DENY <reason>` and closes. TLS stays end to end. Every
  connection, close and refusal is recorded with the target and byte counts, so a target
  the guest asked for and did not get is in the review record. The guest can name any
  destination; the host decides. (`egressResolve` lets the host dial `addr[:port]` for a
  name only the guest resolves, which is how a scripted model server on loopback plays a
  real origin on 443 in the tests.)
- **No credentials in the guest except one.** The model loop needs a provider key, so the
  worker receives exactly that value in its environment, consumes it into the provider
  client, and blanks the variable before any tool can spawn a child. Git remotes, GitHub
  tokens and the host's environment never enter. A secret canary exported on the host is
  checked against every host-owned surface of the run and against the guest's reported
  environment key names.
- **The thread's checkout, not the project's.** A thread with an isolated worktree has its
  own branch and its own uncommitted edits, so the service resolves the checkout through
  `resolveThreadExecutionContext` (the cold resolver the supervisor also uses) and refuses a
  root git cannot snapshot. A broken worktree fails the arming rather than silently falling
  back to the project root, and the record names which checkout ran.
- **Carry-in and carry-out are git bundles.** The host snapshots the working tree (staged,
  unstaged, untracked; `.gitignore` respected) into a commit without moving HEAD, bundles it
  under a run-scoped ref, and the guest fetches it onto a `work` branch. At the end the
  worker commits anything left uncommitted, bundles `carryInBase..work`, and the host
  fetches that into `refs/copse/runs/<id>`. The host's HEAD never moves and nothing is ever
  pushed by the run.
- **Budgets end runs; modals do not.** Wall-clock and token ceilings are mandatory at arm
  time. The worker aborts its own loop at the ceiling and records the reason; the host stops
  the container at the wall-clock budget as a backstop. Neither Docker call is trusted to
  settle: the stop has its own timeout and a bounded grace period settles the wait either
  way, so a hung daemon cannot strand a run short of its cleanup. Teardown is idempotent.
- **A run is only finished when it is actually finished.** The service judges the record
  rather than the guest's word: commits that were produced but could not be fetched, a
  container that would not stop or reap, and a leaked secret canary all keep a run out of
  the `finished` phase and are surfaced as the failure reason or a warning. The UI never
  says commits are back when no ref was fetched.
- **The image is keyed to the worker build.** Reuse is decided by a fingerprint of the guest
  bundle, the Dockerfile, the entrypoint, the uid and the sandbox-runtime version, stored as
  an image label — so an app upgrade rebuilds instead of silently running the previous
  guest's security behaviour.
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

The renderer sends a prompt, a model id and two numbers over `container:run-thread`; the main
process (`container-runtime/container-run-service.ts`) resolves the checkout, the provider
(`providers/container-provider.ts`: local servers, OpenAI, OpenRouter and extra providers
through the guest's OpenAI-compatible client; Anthropic through the product's own resolver
inside the guest) and the key, builds the worker image on first use from the bundle the
build emits and the sandbox runtime copied from the app's own `node_modules`, and pushes
`ContainerRunProgress` snapshots over `container:run-changed`. Arming is written to the
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
  end-to-end, and since A-1 the guest reaches any port through its loopback proxy, so no
  privileged bind and no sysctl is involved.
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
  `~/Library/Application Support/…/runtimes/<id>/egress/broker.sock` is longer and the
  failure is a hang rather than an error. The broker refuses a path over 100 bytes and the
  socket lives under the system temp root in a short digested directory
  (`copse-cx-<10 hex>`), mounted into the guest from there, with an empty `egress`
  directory kept in the run dir purely as the mountpoint the read-only bind cannot create.
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

## Agent models in the guest (ACP)

**Status: Proposed.** Today the run dialog lists agent-backed models (ACP agents, remote
agents, plugin agents) greyed out as "not available in a container", and
`resolveContainerProvider` refuses them with the reason. This section is the plan for
making the ACP ones run. It is written so that every phase before the last is inert: the
refusal stays until the pieces it depends on exist.

### What an agent model is, and why the guest cannot run one today

An `acp:<agent>[#<model>]` selection is not a model. It is a **separate program** — `claude-agent-acp`,
`codex-acp`, `cursor-agent acp`, `gemini --acp` — that Copse spawns on `PATH` and talks to
over ACP JSON-RPC on stdio (`acp-client.ts:448`). Three things follow, and each is a
reason the guest cannot run one now:

1. **It authenticates as the user, from its own store.** Each agent keeps an OAuth login
   under `$HOME` (`acp-known-agents.ts` `homeDirs`: `.claude`, `.codex`, `.cursor`,
   `.gemini`) or reads its own vendor key (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`,
   `GEMINI_API_KEY`). The guest's `$HOME` is an empty tmpfs; the one key it receives is
   blanked before any child spawns (`worker-entry.ts`); `buildAcpAgentEnv` scrubs every
   provider key from an inherited environment (`child-process-env.ts:41`); and the
   secret canary asserts nothing leaked. Decision 3 in `unattended-runs.md` is the reason
   all of that exists.
2. **It needs egress the broker cannot express.** The catalogue's `allowedDomains` are
   wildcards — `*.anthropic.com`, `*.claude.ai`, `*.openai.com`, `*.chatgpt.com`,
   `*.cursor.com` — and OAuth refresh moves between subdomains. The broker as first shipped
   accepted only a literal `host:port`. Worse, its entrypoint started one
   `socat TCP-LISTEN:<port>,bind=127.0.0.1` per origin, so **two origins on 443 collided**
   and the second listener died, backgrounded and unlogged. A-1 replaced that scheme
   (decision A2) and this point is now met; it is kept here because it is why A2 looks the
   way it does.
3. **It runs its own tool loop.** The run's headline claim — no prompt reached a handler,
   outward effects queued for review — is a property of Copse's harness:
   `ensureShellCommandPermitted`, `decideContainedShellEffect`, and the deferral queue. An
   ACP agent executes its own tools and raises `session/request_permission` for the ones
   it wants approved (`acp-agent-service.ts:95`). None of that passes the gate. OS
   containment still holds — read-only rootfs, no capabilities, no interface but the
   broker — so a stray `git push` still cannot reach anything. But the review queue would
   be empty, and `promptsAttempted === 0` would be true for the wrong reason.

Two smaller facts complete the picture. The binary is not in the image: the worker image
installs `bubblewrap ca-certificates git ripgrep` and nothing else
(`worker-image-files.ts`), and Copse deliberately ships none of these agents
(`acp-known-agents.ts` header). And the isolation the desktop gives an agent does not carry
over: `acp-session-host-worker.js` is a standalone bundle (`scripts/main-bundles.mts:58`)
that `buildWorkerImage` never stages, so `spawnTransport` would fall back to an in-process
spawn with a warning; and `willSandboxAcpAgent` would be true inside the guest
(`acp-client.ts:374`), nesting a second bubblewrap with its own network scope inside a
container that has no network. Untested, and at best redundant.

Everything else already works. `runHeadlessAgent` passes the model id straight through
(`headless-agent-host.ts:238`); `runAgent` routes `acp:` to `runAcpTurn` with no changes
(`agent-service.ts:1254`); the only reason the guest's turn would fail is
`getAcpAgent` reading `registeredAcpAgents` from the explicit settings overlay and finding
none (`acp-agent-service.ts:371`). Carrying the agent config in the run spec fixes that in
one place.

### What it would buy, honestly

Not billing. The thing that makes an ACP agent attractive on the desktop — running on the
user's subscription login — is exactly the thing containment cannot hold. Under an API key
the run costs what the provider path costs. What it buys is the **agent's own harness**:
its tools, skills, planning and habits. For a task the user would hand to Claude Code or
Codex on the desktop, that is a real reason. It is bought at the price of the deferral
guarantee, and the record must say so.

### Decisions

- **A1 — credentials: a vendor API key, scoped to the run, never the login.** The key
  travels as the existing single run-scoped env var, is read by the worker and blanked as
  today, and reaches the agent only through the config's explicit `env` map — the one
  path `buildAcpAgentEnv` does not scrub. Mounting the user's `$HOME` login into an
  unattended container is rejected: it puts a live session where nobody is watching, and
  the secret canary exists to catch precisely that. Decision 3 stays "narrowed": exactly
  one credential, by value, for the run — now held by a third-party process, which is the
  material change and the reason for A3.
- **A2 — one broker socket and a CONNECT proxy, not one socket per origin.** Replace the
  per-origin `socat`/`--add-host` scheme with a small guest-side HTTP CONNECT proxy on
  loopback, advertised through `HTTPS_PROXY`/`HTTP_PROXY`, which forwards every connection
  over a single unix socket to the host broker; the broker reads the CONNECT target,
  matches it against a **pattern** allowlist (exact hosts and `*.suffix` entries), and
  dials or refuses. This makes wildcards natural, removes `--add-host`, and fixes the 443
  collision by construction. The connection log gains the target per connection, which
  the record already wants. The provider path keeps working unchanged: the guest's
  OpenAI-compatible client and the product resolver both honour the proxy variables.
  Rejected alternative: a distinct loopback port per origin with rewriting — fixes the
  collision, cannot express wildcards, and leaks the mapping into every client.
- **A3 — the record names the harness, and outward effects are denied, not deferred.**
  `ThreadContainerResult` gains `harness: 'copse' | { acp: <agentId> }`. Under an ACP
  harness the guest answers `session/request_permission` with a fail-closed handler that
  applies `decideContainedShellEffect` to any command it can see: in-guest effects allowed,
  host escapes and outward effects **denied** — not deferred, because a deferral is a
  promise to replay the exact request from the host, and an agent's own tool call cannot
  be replayed by us. Every decision is recorded. `promptsAttempted` counts permission
  requests the handler refused, so the invariant keeps a meaning: zero means the agent
  never asked for something it was not allowed. The dialog and banner say "ran under
  <agent>" so nobody reads a Copse-harness record into an agent run.
- **A4 — the binary is baked, pinned and fingerprinted.** `WORKER_DOCKERFILE` gains a layer
  per npm-installable catalogue agent (`installPackage`), pinned to a version, on a build
  that already has network. The versions join `workerBuildFingerprint` so an upgrade
  rebuilds. `cursor-agent` has `autoInstall: false` and no key path (its `setup` is a
  browser login), so it is not baked and stays unavailable — with a per-agent reason.
- **A5 — the container is the sandbox.** `acp-session-host-worker.js` is staged so the
  session host works; the guest sets the ACP sandbox off (`willSandboxAcpAgent` false)
  because the container already provides what the seatbelt would, and nested bubblewrap
  with a network scope inside `--network=none` is undefined behaviour we do not want to
  own.
- **A6 — scope is the key-capable agents.** `claude-acp` / `claude-code-acp`
  (`ANTHROPIC_API_KEY`), `codex-acp` (`CODEX_API_KEY`), `gemini` (`GEMINI_API_KEY`).
  Anything without a documented key path stays greyed out, and the reason is per agent:
  "signs in through a browser, no key path" rather than the generic line.

### Phases

Each phase lands green and inert until A-3. The refusal in `resolveContainerProvider` is the
switch, and it stays until the phase that removes it can prove its properties.

- **A-0 — plumbing behind the refusal.** Bake the pinned agents into the image (A4); stage
  `acp-session-host-worker.js` (A5); carry `AcpAgentConfig` in the run spec and into the
  guest's `registeredAcpAgents`; add `harness` to the result and record. Exit gate: the
  image builds and its fingerprint moves with the agent versions; a unit test proves the
  guest would resolve the agent; the refusal is unchanged and its test still passes.
- **A-1 — egress rework. Landed.** The CONNECT proxy and pattern allowlist (A2), with the
  provider path migrated onto it: `egress-rules.ts` (the grammar, pure), `egress-broker.ts`
  (one socket, `CONNECT`/`OK`/`DENY`, refusals logged), `guest-egress-proxy.ts` (loopback
  proxy in the worker bundle; `CONNECT` tunnels and absolute-form plain HTTP, re-chunked
  and streamed so server-sent events arrive as sent). `--add-host`, the sysctl and `socat`
  are gone. Exit gate as met: at the unit tier two hosts on one port through one broker,
  a wildcard admitting a subdomain and refusing the bare suffix and two siblings, and a
  remapped dial matched and logged on the port the guest named; at the integration tier
  the model is reached on guest port 443 by a wildcard rule, with the rule in the log and
  no refusal. Two origins both _reached_ from inside the guest at the integration tier
  waits for a second guest-side caller: the auto-run shell in the guest has no network by
  design, so only the model loop dials out until A-2's agent does.
- **A-2 — credentials and the permission policy.** The key by env map (A1); the
  permission handler and its record (A3). Exit gate: an integration test with a
  **scripted ACP agent** — a small stdio program speaking ACP, standing in for a real one —
  that requests permission for an in-guest write (allowed), an outward push (denied,
  recorded), and a host escape (denied, recorded); the canary is absent; the record names
  the harness.
- **A-3 — a real agent, and the refusal removed for A6's set.** `claude-acp` with a real
  key against the broker: the U0-style report over the run's own decision log, prompts
  refused vs allowed. Exit gate: the run ends with commits under `refs/copse/runs/<id>`
  and a record a reviewer can read without knowing which harness ran until they look.
- **A-4 — the dialog.** Rows for A6's agents enabled when a key is in Settings; every other
  agent row carries its own reason. The note under the model field says which agents
  can run and why the rest cannot.

### What this does not change

The container's hardening, the attestation, the ledger, the budgets and the carry-in/out are
untouched. Guarded YOLO is untouched. Copse's own harness remains the default and the
recommended path for container runs; the provider-backed twin of an agent's model is
already in the list, one group up, and it keeps the deferral guarantee.

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

| Area                   | Tier        | What it proves                                                                                                    | Where                                                       |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Effect classification  | unit        | Host escapes deny; outward effects defer; in-guest destruction allows; harm denies stay denies                    | `packages/shell-guard/src/container-effects.test.ts`        |
| Attestation            | unit        | Every shortfall (root, writable rootfs, caps, privileges, foreign mount) refuses the declaration                  | `security/unattended-run.test.ts`                           |
| Ledger                 | unit        | Arming implies deferral mode; mutually exclusive with Guarded YOLO both ways; budgets required                    | `security/unattended-run.test.ts`                           |
| Gate matrix            | unit        | Command class × containment tier × unattended → exact outcome, including the desktop-tier and not-armed rows      | `security/unattended-run.test.ts`                           |
| Deadline settlement    | unit        | A failed or hung `docker stop` with a still-pending wait still settles, and says why                              | `container-runtime/thread-container.test.ts`                |
| Image freshness        | unit        | The fingerprint changes with the worker bundle and the base image                                                 | `container-runtime/thread-container.test.ts`                |
| Completion honesty     | unit        | Unfetched commits, failed teardown and a leaked canary are never a clean finish                                   | `container-runtime/container-run-service.test.ts`           |
| Thread checkout        | unit (git)  | A thread worktree with its own commits and edits is carried in, not the project checkout                          | `container-runtime/container-run-service.test.ts`           |
| Docker argv and record | unit        | The flags the attestation claims are the flags used; only the run dir is mounted; key passed by name              | `container-runtime/thread-container.test.ts`                |
| Carry-in / carry-out   | unit (git)  | Dirty tree snapshots without moving HEAD; guest commits round-trip to `refs/copse/runs/<id>`                      | `container-runtime/thread-container.test.ts`                |
| End to end             | integration | The eight properties listed above, against a real daemon, opt-in via `COPSE_THREAD_CONTAINER_E2E=1`               | `container-runtime/thread-container.integration.test.ts`    |
| Provider plan          | unit        | Model id → endpoint, key and the one egress origin; cloud models without a key are refused before Docker          | `providers/container-provider.test.ts`                      |
| Run service            | unit        | Provider resolved, key passed by env var and blanked once the guest holds it, phases published, refusals          | `container-runtime/container-run-service.test.ts`           |
| UI (browser tier)      | demo        | Footer action, arming form with the draft prefilled, banner and review record for a finished run                  | `tests/demo/container-run.demo.ts`                          |
| UI (Electron)          | e2e         | Real IPC: the dialog opens from the footer and a model without a key is refused with a readable error             | `tests/e2e/container-run-dialog.e2e.ts`                     |
| ACP: agent resolution  | unit        | A run spec carrying an `AcpAgentConfig` makes `getAcpAgent` resolve inside the guest's settings overlay           | `container-runtime/worker-entry.test.ts` (A-0)              |
| ACP: image bake        | unit        | The fingerprint moves with each pinned agent version; `cursor-agent` is never baked                               | `container-runtime/thread-container.test.ts` (A-0)          |
| ACP: egress grammar    | unit        | `host:port` and `*.suffix:port` parse and format; `*.com` is refused; the wildcard matches on the dot boundary    | `container-runtime/egress-rules.test.ts` (A-1)              |
| ACP: egress patterns   | unit        | Two hosts on one port through one socket; `*.suffix` admits a subdomain, refuses the suffix and siblings; logged  | `container-runtime/egress-broker.test.ts` (A-1)             |
| ACP: guest proxy       | unit        | Absolute-form HTTP streams an SSE body back with hop-by-hop headers dropped; CONNECT tunnels; DENY becomes a 403  | `container-runtime/guest-egress-proxy.test.ts` (A-1)        |
| ACP: 443 in the guest  | integration | The model on guest port 443 is reached through the proxy, admitted by a wildcard rule named in the log            | `container-runtime/thread-container.integration.test.ts`    |
| ACP: permission policy | integration | A scripted ACP agent: in-guest write allowed, outward push denied and recorded, host escape denied, harness named | `container-runtime/acp-container.integration.test.ts` (A-2) |
| ACP: refusal           | unit        | Agents outside A6's set, and any agent without a key, are refused with a per-agent reason                         | `providers/container-provider.test.ts` (A-4)                |

## Non-goals

- A hostile-workload or multi-tenant boundary. The guest is the user's own disposable
  machine, started by their own daemon, and the UI must say so.
- A second permission vocabulary, transport, queue or scheduler. The gate gained one branch
  and one prompt cause; the queue, the decision log and the headless host are the existing
  ones.
- Auto-approving anything whose effect leaves the guest. Under an ACP harness that means
  _denying_ it: an agent's own tool call cannot be replayed from the host, so it is not
  deferred (decision A3).
- Mounting a user's login into the guest, for any agent, ever (decision A1).
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
