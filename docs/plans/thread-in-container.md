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
Key-capable agent models (ACP: Claude, Codex, Gemini) run in the guest under a vendor API
key; the others are offered greyed out with a per-agent reason. That route is described, and
its status tracked, under
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
   relaxed to allow user namespaces. (The prototype started that way; decision A7 below
   removed the nested sandbox once it was clear the container was the boundary.)

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
  stdin/stdout (frames) ◀─▶ EgressBroker (allowlist)  127.0.0.1:3128 CONNECT proxy → link
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
- **Egress is deny-by-default and named.** The container has no network interface. Its
  stdin and stdout are a link to the host (`egress-link.ts`: frames over the attached
  container's stdio, decision A8); the worker starts an HTTP CONNECT proxy on its own
  loopback (`guest-egress-proxy.ts`) and every client in the guest is pointed at it
  through `HTTPS_PROXY`/`HTTP_PROXY` (Node's global `fetch` honours them under
  `NODE_USE_ENV_PROXY=1`). Each connection opens one stream on the link, `OPEN host:port`;
  the host-side `EgressBroker` matches it against the run's allowlist — exact `host:port`
  entries and `*.suffix:port` wildcards (`egress-rules.ts`) — then accepts and pipes
  bytes, or refuses with `DENY <reason>`. TLS stays end to end. Every
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
| 9 — not a hostile-workload boundary                  | Kept. The container is the user's own disposable machine, not a multi-tenant claim. (It ran `seccomp=unconfined` while a bubblewrap nested inside it; A7 put the default profiles back.)                                     |
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
  not allow non-privileged user namespaces"; `apparmor=unconfined` and
  `systempaths=unconfined` follow. The prototype paid that to nest a per-command sandbox;
  decision A7 stopped paying it, and the attestation now records `securityProfiles`.
- **`# syntax=docker/dockerfile:1` pulls a frontend image from Docker Hub.** In a sandbox
  where Hub is rate-limited or blocked the build fails before reading line 2. Leave it out.
- **`git fetch` into the checked-out branch is refused, even an unborn one.** The guest
  initialises on a placeholder branch and fetches into `work`, then checks it out.
- **The sandbox runtime is not bundleable.** `@anthropic-ai/sandbox-runtime` resolves helper
  files by path at run time, so it stays external and is installed into the image at the
  version pinned in the lockfile. `node-pty` is aliased to a throwing stub: the worker
  offers no PTY, and a missing native module at load time would otherwise stop the bundle.
- **A unix socket in a bind mount does not connect on Docker Desktop.** The first real
  run on macOS finished "completed" with an empty broker log and a 403 on every request:
  the socket mounted, and `connect` on it returned `ENOTSUP` (VirtioFS carries files, not
  sockets). Before that, `sun_path`'s 104-byte cap had already forced the socket out of
  the profile directory into a short digested temp path. Both went away with decision A8:
  the link is the container's own stdio, which every backend can attach. The worker now
  probes the link before anything else and fails the run by name if the host does not
  answer, and a brokered run whose broker saw no connection is never a clean finish.
- **The guest's stdout belongs to the link.** With stdio as the transport, one stray
  `console.log` in the worker bundle would land inside a frame. The worker takes stdout's
  original `write` for the link first thing and points `process.stdout` at stderr, so the
  run's log — the worker's own lines, an agent's stderr — arrives on stderr and streams
  to the dialog as it happens instead of as a `docker logs` tail at the end.
- **`git add -A` fails inside a bubblewrap-contained process.** The Linux sandbox
  materialises its mandatory write-deny paths (`.bash_profile`, `.vscode`, …) as mount
  points in the checkout for the life of the sandboxed process
  ([`linux-sandbox-rollout-followups.md`](linux-sandbox-rollout-followups.md) §0), and git
  refuses to add a mount point. A pre-existing Linux limitation, not a container one; it
  no longer applies in the guest since A7, and still applies to the desktop's `stage_all`.
- **The guest's uid is not the host's.** The `state`, `out` and `egress` directories under
  the run directory are created world-writable so an unprivileged guest uid can write them.
  They are per-run and under the user's own profile; a user-namespace remap is the cleaner
  answer and is not built.
- **Some sandboxes cannot reach Docker Hub or Debian's archive.** The image takes
  `--base-image` and `--build-network` (and the matching `COPSE_WORKER_*` variables) so a
  mirror or a locally built base can substitute without editing the Dockerfile.

## Agent models in the guest (ACP)

**Status: Landed on the branch, except the real-agent run (A-3's exit gate needs a vendor
key this sandbox does not have).** The run dialog enables the key-capable ACP agents
(`container-acp-agents.ts`: Claude, Codex, Gemini) when their vendor key is in Settings and
greys out every other agent with its own reason; `resolveContainerProvider` builds an `acp`
plan for the former and refuses the latter with the same reason. The guest registers the
one agent for the run, gives it the run's key as its only variable, runs it without a nested
seatbelt, and answers its permission requests by blast radius — outward effects refused and
recorded, never deferred. The record names the harness. This section was the plan; it is
kept as the record of the decisions and of what each phase proved.

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

Two smaller facts completed the picture as it stood. The binary was not in the image: the
worker image installed `bubblewrap ca-certificates git ripgrep` and nothing else, and Copse
deliberately ships none of these agents (`acp-known-agents.ts` header) — A4 bakes the
key-capable ones in. And the isolation the desktop gives an agent does not carry over:
`acp-session-host-worker.js` is a standalone bundle (`scripts/main-bundles.mts`) that
`buildWorkerImage` never stages, and `willSandboxAcpAgent` would be true inside the guest,
nesting a second bubblewrap with its own network scope inside a container that has no
network — A5 makes the container the sandbox instead.

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
- **A1′ — the sign-in, on explicit opt-in, for the agents that keep it in files.** Asked
  for by the author after A1 shipped: a user who runs Codex on a ChatGPT login and reaches
  OpenAI models only through OpenRouter has no OpenAI key to give, and the row stayed
  greyed. The run may instead copy the agent's sign-in **files** — named per agent in
  `container-acp-agents.ts` (`~/.codex/auth.json`; Gemini's `oauth_creds.json`,
  `google_accounts.json` and `settings.json`) — into the guest's throwaway home
  (`agent-login.ts`), when the user ticks "Use my <agent> sign-in for this run" in the
  dialog. Files and not the catalogue's `homeDirs`, and copied asynchronously, because
  the first cut copied `~/.codex` whole and synchronously on the main process: that
  directory also holds every session transcript the CLI ever wrote, and the app
  beachballed for as long as the copy took. What A1 said still holds and is why this is an opt-in and not a default: it is
  the whole account rather than a scoped key; the guest's token refresh may rotate the
  desktop's out; and it exists only for agents whose login lives in files — Claude Code
  keeps its OAuth credentials in the macOS Keychain, so it stays key-only. The copy is
  staged world-readable inside the run directory (the worker uid does not exist on the
  host), removed in `finally` however the run ends, restored private to the worker in
  the guest, and never bind-mounted, so nothing the agent writes reaches the host. A key,
  when present, always wins. The record says which was held (`credential`), the arming
  decision says it, and the dialog shows it.
- **A2 — one broker link and a CONNECT proxy, not one socket per origin.** Replace the
  per-origin `socat`/`--add-host` scheme with a small guest-side HTTP CONNECT proxy on
  loopback, advertised through `HTTPS_PROXY`/`HTTP_PROXY`, which forwards every connection
  over a single link to the host broker (a unix socket at first; the container's stdio
  since A8); the broker reads the target,
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
- **A5 — the container is the sandbox.** The agent config the guest registers carries
  `sandbox: false`, so the agent spawns without a seatbelt of its own — the container already
  provides what the seatbelt would, and nested bubblewrap with a network scope inside
  `--network=none` is undefined behaviour we do not want to own. Because that config never
  asks for a sandbox, `spawnTransport` never reaches for the session host, and
  `acp-session-host-worker.js` is _not_ staged: staging a bundle the guest cannot use would
  only widen the image. For every decision that asks "is this agent's process contained?"
  — auto-approving its reads, defaulting Claude to `acceptEdits`, the prompt's sandbox note
  — the guest answers yes (`acp-agent-service.ts`, `contained`).
- **A7 — the container is the sandbox, for every harness; no bubblewrap inside it.** Asked
  by the author after the first real run: what is the nested sandbox for? On the desktop
  bubblewrap gives an auto-run command four things — writes confined to the workspace, a
  network namespace with an allowlist bridge, a PID namespace, and the prompt-on-escape
  that the permission model rests on. In the guest the rootfs is read-only and the
  workspace, home and `/tmp` are throwaway tmpfs, there is no network beyond the broker,
  nothing in the container can see the host, and prompt-on-escape is exactly what the
  contained-effect policy replaces. What the nesting cost was real: `seccomp=unconfined`,
  `apparmor=unconfined` and `systempaths=unconfined` on the container so bubblewrap could
  create namespaces, plus bubblewrap, socat and the runtime's initialisation in the image,
  plus the `git add -A` mount-point quirk. So the guest no longer initialises the project
  sandbox at all, the image carries neither bubblewrap nor socat, and the container runs
  under Docker's default seccomp and AppArmor profiles; the attestation records
  `securityProfiles: 'default'`. The one thing worth keeping — an auto-run shell command
  cannot reach the network — is kept without namespaces: the host mints a per-run token,
  the guest proxy refuses any request without it (`407`), the worker's own client gets it
  through the proxy URL Node's env-proxy dispatcher reads once at startup, the agent gets
  it through its explicit env map, and the worker blanks the variables from its own
  environment before it spawns anything, so shell children inherit no proxy and no token
  (`perCommandNetwork: 'token-gated'`; proven in `guest-egress-proxy.test.ts` and by a
  Node 22 probe of the dispatcher's capture-at-startup). Residual, recorded rather than
  hidden: a child runs as the same uid as the worker and can read the worker's initial
  environment from `/proc`, so a deliberately hostile command could recover the token and
  reach the allowlisted vendor origins — the same hosts the model already sends the
  repository to. A namespace was the only thing that closed that, and it was not worth the
  container's syscall filter. An ACP agent's own shell children inherit the agent's token,
  as they inherit its seatbelt scope on the desktop.
- **A8 — the egress link is the container's stdio, not a unix socket.** The first real
  ACP run on the author's Mac showed the broker had never been reached: Docker Desktop's
  VirtioFS file sharing mounts a host unix socket as a file that `connect` refuses with
  `ENOTSUP`. Rather than a per-platform transport (a TCP listener on `host.docker.internal`
  is unreachable from a `--network none` container and would need its own token scheme),
  the container is now created with `--interactive` and started with
  `docker start --attach --interactive`: its stdin and stdout carry a small multiplexing
  protocol (`egress-link.ts`: `OPEN`/`ACCEPT`/`REFUSE`, `DATA`/`END`/`RESET` per stream,
  `PING`/`PONG` on stream 0, flow control by the pipe itself with a paused inbound side
  when a reader is slow), its stderr is the run's log, streamed live. The broker keeps its
  allowlist, its resolve map and its log unchanged; only the transport moved. Two
  properties came free: the host dying severs the link, and the worker treats that as a
  stop, so an orphaned container winds itself down; and there is no host path, socket
  length or mountpoint to get wrong. Rejected: keeping the socket and asking macOS users
  to switch Docker Desktop to gRPC FUSE (a setting the run cannot verify, and slower for
  everything else they do).
- **A9 — a Node 24 image with pnpm, a per-run volume, and an opt-in install step.** The
  first complete Codex run could not run the project's tests: the guest had Node 22, no
  pnpm, no `node_modules`, and no route to a registry, so the agent read CI evidence
  instead. Three changes. The image builds on `node:24-bookworm-slim` with a pinned pnpm
  baked in (`PNPM_VERSION`, part of the fingerprint). The workspace is a per-run named
  Docker volume (`copse-ws-<id>`, labelled, created before the container and removed in
  teardown) rather than a 2 GB tmpfs: a project's `node_modules` runs to gigabytes and
  tmpfs pages are charged to the memory limit; the volume lives on the daemon's disk and
  never on a host path, so the containment attestation is unchanged. And the dialog
  offers "Install dependencies before the run", on by default: the worker runs the
  checkout's lockfile install once, before the agent, with the run's proxy
  (`guest-install.ts`: pnpm for `pnpm-lock.yaml`, `npm ci` for `package-lock.json`, the
  pnpm store beside the checkout so an agent's `git add -A` cannot sweep it in), and
  `registry.npmjs.org:443` joins the allowlist for that run. Postinstall binary downloads
  (Electron, Playwright, Puppeteer, Cypress) are switched off container-wide: their hosts
  are never admitted and an install that waited on them would only fail later. The
  agent's own shell stays off the network (A7): it cannot add a package mid-run, and that
  is the intended shape. A failed install is said in the log and the run goes on. The
  first real install got 668 packages in and then lost one to the desktop's resolver
  answering `ENOTFOUND` for a name it had just answered a thousand times, which the guest
  proxy turned into a 403 that pnpm treated as final. The broker now resolves each host
  once per run and retries a transient dial fault (`EAI_AGAIN`, `ENOTFOUND`, `ECONNRESET`,
  `ETIMEDOUT`) with a short backoff, and the proxy answers 502, the status clients retry
  on, for an origin that did not answer; 403 stays for a refusal, which is final. The
  second real install then fetched everything and failed on two install scripts: a driver
  download from a host the run never admits, and a native build with no toolchain in the
  image. So the install is three steps — fetch and link with scripts off (required), then
  native builds and the project's own `postinstall`/`prepare` as best effort, each failure
  named and passed over — and the image carries python3, make, g++ and pkg-config.
- **A10 — no GitHub or CI tool in the guest, by name.** Asked by the author after the
  first complete run: does the agent hold write tools to GitHub? The bridge's ceiling
  includes four that write (`gh_pr_create`, `gh_pr_approve`, `gh_pr_mark_ready`,
  `gh_pr_enable_auto_merge`) and they register on the desktop when `gh` is on the PATH or a
  GitHub token is in the environment. Neither holds in the guest, so the first run offered
  23 tools and none of them — but absence by accident is not a property. The headless
  profile gained `excludeTools`, applied after bootstrap and before the agent sees a list,
  and the worker passes every GitHub and CI tool name (`guest-tools.ts`, with a test that
  fails when a new `gh_*` tool reaches the bridge list without joining the exclusion).
  `run_shell` remains: it has no `gh`, no token, no route to github.com, and a `git push`
  through it is an outward effect the contained gate refuses and records.
- **A6 — scope is the key-capable agents.** `claude-acp` / `claude-code-acp`
  (`ANTHROPIC_API_KEY`), `codex-acp` (`CODEX_API_KEY`), `gemini` (`GEMINI_API_KEY`).
  Anything without a documented key path stays greyed out, and the reason is per agent:
  "signs in through a browser, no key path" rather than the generic line.

### Phases

Each phase was to land green and inert until A-3, with the refusal in
`resolveContainerProvider` as the switch. A-0, A-2, A-3's code and A-4 landed together on
the branch once A-1 was in, because they share one seam (the run spec's `acp` field) and
were smaller apart than the plan expected; what is recorded under each is what it proved.

- **A-0 — plumbing. Landed.** `WORKER_DOCKERFILE` takes an `ACP_AGENTS` build argument of
  pinned `package@version` specs (`container-acp-agents.ts`) and installs them globally
  before dropping to the worker user; the specs join `workerBuildFingerprint`, so a version
  bump rebuilds, and `acpAgents: []` builds an agent-free image for tests. The run spec
  carries `acp: { agent, keyEnvName }`; the worker registers that one agent in its settings
  overlay (`guest-acp-agent.ts`), so `getAcpAgent` resolves it and nothing else. The result
  and record gained `harness` and `denials`. Exit gate as met: the fingerprint moves with
  the agent list; the Dockerfile is asserted layer by layer; the two directions of the
  config crossing are unit-tested (`guest-acp-agent.test.ts`). The image build with the
  real agents baked in has not been run here — this sandbox cannot reach the npm registry
  from a Docker build — and is the first thing to run where it can.
- **A-1 — egress rework. Landed.** The CONNECT proxy and pattern allowlist (A2), with the
  provider path migrated onto it: `egress-rules.ts` (the grammar, pure), `egress-broker.ts`
  (`CONNECT`/`OK`/`DENY` over one unix socket, since A8 `OPEN`/`ACCEPT`/`REFUSE` over the
  container's stdio, refusals logged), `guest-egress-proxy.ts` (loopback
  proxy in the worker bundle; `CONNECT` tunnels and absolute-form plain HTTP, re-chunked
  and streamed so server-sent events arrive as sent). `--add-host` and the sysctl are
  gone. (`socat` briefly came back when the first real run reported "socat not installed"
  from the sandbox runtime's bridge; A7 then removed the nested sandbox and socat with it.) Exit gate as met: at the unit tier two hosts on one port through one broker,
  a wildcard admitting a subdomain and refusing the bare suffix and two siblings, and a
  remapped dial matched and logged on the port the guest named; at the integration tier
  the model is reached on guest port 443 by a wildcard rule, with the rule in the log and
  no refusal. Two origins both _reached_ from inside the guest at the integration tier
  waits for a second guest-side caller: the auto-run shell in the guest has no network by
  design, so only the model loop dials out until A-2's agent does.
- **A-2 — credentials and the permission policy. Landed and proven locally; its
  Docker integration test is written and not yet run.** The worker consumes the run's key from its environment as
  before and hands it to the agent as the one entry of its explicit `env` map (A1); the
  user's own `env` never crosses (`acpHarnessForContainer`). Inside a contained run the
  ACP permission responder treats the agent as contained: reads auto-approve, edits go
  through the backup-then-allow path, and an `execute` request runs the contained gate
  with `outwardEffects: 'deny'` — a new gate option that refuses and records an outward
  effect instead of queueing it, because an agent's own command cannot be replayed by
  Copse (A3). A host escape's throw is answered to the agent as a rejection rather than a
  transport error. Any other kind that would reach a dialog is refused and recorded
  (`kind: 'acp'`). The worker reads the refusals back from the run's decision log into
  `result.denials`. Exit gate: `acp-container.integration.test.ts` runs a **scripted ACP
  agent** (`scripted-acp-agent.ts`, carried in with the workspace) that asks for an
  in-guest build (allowed, and run by the agent), an outward push (refused), a host
  escape (refused), then commits; it asserts the harness is named, prompts and deferrals
  are zero, two denials are recorded, the agent saw exactly the run's key and no canary,
  and the work came back. Needs Docker to run. The seam it exercises is proven without
  the container by `acp-harness.test.ts`, in the ordinary unit gate: the same
  `runHeadlessAgent` call the worker makes, under a declared container runtime and an
  armed run, with the scripted agent registered through the settings overlay — the real
  ACP client answers its permission requests by blast radius, the build runs and is
  committed by the agent, the push and the escape are refused with nothing queued, both
  refusals are in the decision log, and the agent saw exactly the run's key. The gate
  option itself is unit-tested in `unattended-run.test.ts`.
- **A-3 — the refusal lifted for A6's set. Code landed; the real run is outstanding.**
  `resolveContainerProvider` returns an `acp` plan for a registered key-capable agent
  whose vendor key is in Settings: the full `acp:<id>[#model]` selection as the model,
  the harness, the key, and the agent's catalogue `allowedDomains` on 443 as the egress
  rules. Every other agent is refused with the per-agent reason. Exit gate — a real
  `claude-acp` run ending with commits under `refs/copse/runs/<id>` and a readable
  record — cannot be met here: no vendor key is available in this sandbox. It is the
  second thing to run where one is.
- **A-4 — the dialog. Landed.** `loadRunModelOptions` asks the main process, over
  `container:model-availability`, for the resolver's own verdict on each agent row:
  `explainContainerModel` runs `resolveContainerProvider` and returns null or the short
  reason from the typed refusal ("needs a Gemini API key in Settings", "signs in through a
  browser; no API-key path", "not carried by the worker image", "not configured in
  Settings"). The first cut asked the renderer-side key queries instead and got it wrong
  twice — the validated-provider set greys a key that is merely unprobed, and the
  Settings presence query cannot see a key in the environment that the resolver accepts —
  so the rule is now that only the code that would refuse the start decides the row. The
  note under the field names the agents that can run and what they run on. The record
  view gained a Harness row, an "Effects refused" count and a section listing the
  refusals.

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

| Area                   | Tier        | What it proves                                                                                                                                          | Where                                                                                                                                  |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Effect classification  | unit        | Host escapes deny; outward effects defer; in-guest destruction allows; harm denies stay denies                                                          | `packages/shell-guard/src/container-effects.test.ts`                                                                                   |
| Attestation            | unit        | Every shortfall (root, writable rootfs, caps, privileges, foreign mount) refuses the declaration                                                        | `security/unattended-run.test.ts`                                                                                                      |
| Ledger                 | unit        | Arming implies deferral mode; mutually exclusive with Guarded YOLO both ways; budgets required                                                          | `security/unattended-run.test.ts`                                                                                                      |
| Gate matrix            | unit        | Command class × containment tier × unattended → exact outcome, including the desktop-tier and not-armed rows                                            | `security/unattended-run.test.ts`                                                                                                      |
| Deadline settlement    | unit        | A failed or hung `docker stop` with a still-pending wait still settles, and says why                                                                    | `container-runtime/thread-container.test.ts`                                                                                           |
| Image freshness        | unit        | The fingerprint changes with the worker bundle and the base image                                                                                       | `container-runtime/thread-container.test.ts`                                                                                           |
| Completion honesty     | unit        | Unfetched commits, failed teardown and a leaked canary are never a clean finish                                                                         | `container-runtime/container-run-service.test.ts`                                                                                      |
| Thread checkout        | unit (git)  | A thread worktree with its own commits and edits is carried in, not the project checkout                                                                | `container-runtime/container-run-service.test.ts`                                                                                      |
| Docker argv and record | unit        | The flags the attestation claims are the flags used; only the run dir is mounted; key passed by name                                                    | `container-runtime/thread-container.test.ts`                                                                                           |
| Carry-in / carry-out   | unit (git)  | Dirty tree snapshots without moving HEAD; guest commits round-trip to `refs/copse/runs/<id>`                                                            | `container-runtime/thread-container.test.ts`                                                                                           |
| End to end             | integration | The eight properties listed above, against a real daemon, opt-in via `COPSE_THREAD_CONTAINER_E2E=1`                                                     | `container-runtime/thread-container.integration.test.ts`                                                                               |
| Provider plan          | unit        | Model id → endpoint, key and the one egress origin; cloud models without a key are refused before Docker                                                | `providers/container-provider.test.ts`                                                                                                 |
| Run service            | unit        | Provider resolved, key passed by env var and blanked once the guest holds it, phases published, refusals                                                | `container-runtime/container-run-service.test.ts`                                                                                      |
| UI (browser tier)      | demo        | Footer action, arming form with the draft prefilled, banner and review record for a finished run                                                        | `tests/demo/container-run.demo.ts`                                                                                                     |
| UI (Electron)          | e2e         | Real IPC: the dialog opens from the footer and a model without a key is refused with a readable error                                                   | `tests/e2e/container-run-dialog.e2e.ts`                                                                                                |
| ACP: agent table       | unit        | Only catalogue agents with a documented key are baked; per-agent reasons; a retired id maps to its current entry                                        | `shared/container-acp-agents.test.ts` (A-0)                                                                                            |
| ACP: config crossing   | unit        | Host side drops the user's env and desktop command path; guest side gives the agent exactly the run's key                                               | `container-runtime/guest-acp-agent.test.ts` (A-0)                                                                                      |
| ACP: image bake        | unit        | The fingerprint moves with the agent list and versions; the Dockerfile installs from the argument before `USER`                                         | `container-runtime/thread-container.test.ts` (A-0)                                                                                     |
| ACP: plan              | unit        | A registered key-capable agent with its key gives an `acp` plan on its catalogue domains; no user env crosses                                           | `providers/container-provider.test.ts` (A-3)                                                                                           |
| ACP: run request       | unit        | The service passes the harness and key variable, and no provider, for an `acp:` model                                                                   | `container-runtime/container-run-service.test.ts` (A-3)                                                                                |
| ACP: deny, not defer   | unit        | `outwardEffects: 'deny'` refuses an outward effect with nothing queued; contained effects still run                                                     | `security/unattended-run.test.ts` (A-2)                                                                                                |
| ACP: harness, local    | unit        | The worker's own call under a declared runtime drives the scripted agent: build allowed and committed, push and escape refused and logged, one key seen | `container-runtime/acp-harness.test.ts` (A-2)                                                                                          |
| ACP: sign-in opt-in    | unit        | Codex/Gemini without a key are offered and run only when opted in; a key wins; Claude never; the resolver's verdict carries the offer                   | `shared/container-acp-agents.test.ts`, `providers/container-provider.test.ts`, `container-runtime/container-run-service.test.ts` (A1′) |
| ACP: sign-in crossing  | unit        | Only existing dirs are staged, world-readable, then removed; none found refuses; the guest copy is private to the worker                                | `container-runtime/agent-login.test.ts` (A1′)                                                                                          |
| ACP: roster            | unit        | A key-capable agent row is enabled with its key and disabled naming the key without; browser-login agents differ                                        | `renderer/views/container-run-control.test.ts` (A-4)                                                                                   |
| ACP: egress grammar    | unit        | `host:port` and `*.suffix:port` parse and format; `*.com` is refused; the wildcard matches on the dot boundary                                          | `container-runtime/egress-rules.test.ts` (A-1)                                                                                         |
| ACP: egress patterns   | unit        | Two hosts on one port through one link; `*.suffix` admits a subdomain, refuses the suffix and siblings; a dead origin is a refusal; logged              | `container-runtime/egress-broker.test.ts` (A-1)                                                                                        |
| ACP: guest proxy       | unit        | Absolute-form HTTP streams an SSE body back with hop-by-hop headers dropped; CONNECT tunnels; DENY becomes a 403                                        | `container-runtime/guest-egress-proxy.test.ts` (A-1)                                                                                   |
| ACP: broker probe      | unit        | `PING`/`PONG` on the link; the worker fails a run whose host does not answer; a brokered run that reached nothing is warned about, or failed            | `egress-broker.test.ts`, `guest-egress-proxy.test.ts`, `container-run-service.test.ts` (A8)                                            |
| ACP: install step      | unit        | Lockfile picks pnpm or npm ci, nothing without one; the store sits beside the checkout; the install env carries the proxy and every download switch off | `container-runtime/guest-install.test.ts`, `container-run-service.test.ts` (A9)                                                        |
| ACP: guest tools       | unit        | Every GitHub write tool, and every gh_*/CI tool the bridge could offer, is on the guest's exclusion list                                                | `container-runtime/guest-tools.test.ts` (A10)                                                                                          |
| ACP: stdio link        | unit        | Frames survive any split; a stream half-closes each way; refusal and reset reach the peer; a severed byte stream fails every stream                     | `container-runtime/egress-link.test.ts` (A8)                                                                                           |
| ACP: 443 in the guest  | integration | The model on guest port 443 is reached through the proxy, admitted by a wildcard rule named in the log                                                  | `container-runtime/thread-container.integration.test.ts`                                                                               |
| ACP: permission policy | integration | A scripted ACP agent: in-guest write allowed, outward push denied and recorded, host escape denied, harness named                                       | `container-runtime/acp-container.integration.test.ts` (A-2)                                                                            |
| ACP: refusal           | unit        | Agents outside A6's set, and any agent without a key, are refused with a per-agent reason                                                               | `providers/container-provider.test.ts` (A-3)                                                                                           |

## Non-goals

- A hostile-workload or multi-tenant boundary. The guest is the user's own disposable
  machine, started by their own daemon, and the UI must say so.
- A second permission vocabulary, transport, queue or scheduler. The gate gained one branch
  and one prompt cause; the queue, the decision log and the headless host are the existing
  ones.
- Auto-approving anything whose effect leaves the guest. Under an ACP harness that means
  _denying_ it: an agent's own tool call cannot be replayed from the host, so it is not
  deferred (decision A3).
- Mounting a user's login into the guest. A1′ copies a sign-in in for one run on explicit
  opt-in, for Codex and Gemini only; nothing is mounted, nothing comes back out, and it
  is never the default.
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
