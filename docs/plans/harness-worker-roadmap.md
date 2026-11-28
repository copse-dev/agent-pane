# Roadmap: one harness worker that runs anywhere

**Status: Proposed (27 November 2026).** This roadmap orders the work toward one target. It
does not replace the plans it links to: each phase points at the plan that owns the detail,
and this file only fixes the order, the dependencies and the exit gates between them.

## The target

Every place a thread runs becomes the same Copse harness worker: the headless agent loop,
holding the writer lease on the threads it owns. Windows, the phone and any future shell are
clients. They attach, watch, answer decisions and detach, and never own a turn. Where the
worker lives (this machine, an SSH host, a container or a cloud machine) is a deployment
choice, not a separate product.

```text
 Clients (attach, detach, never own a turn)        Harness workers (same bundle, any host)
 ──────────────────────────────────────────        ───────────────────────────────────────
  Desktop window ─┐                                 ┌─ Local worker        outlives the app
  Phone / web ────┼── one protocol ───────────────► ├─ Worker on SSH host  laptop can close
  Other shells ───┘   chunks, checkpoints,          ├─ Worker in container attachable
                      decisions, store writes       └─ Worker on cloud box detached
                                                         │
                                                         ├─ thread store + per-thread lease
                                                         └─ external ACP agents it hosts
```

Three rules hold in every phase:

1. **Only the lease holder writes a thread.** Any process may read and stream it.
2. **Nobody watching is normal.** Decisions go to whichever client is attached. With none
   attached they defer, and they never wait on a dialog nobody can answer.
3. **No new listening surface.** A remote worker is reached over a channel that already
   exists (the SSH ControlMaster, the container's stdio link, the relay the phone uses), never
   a new open port.

## Where things stand

| Piece                          | State                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-thread writer lease        | Built (`writer-lease.ts`). Epoch checks at store write sites and leases on writes outside a turn are still open.                                            |
| Worker bundle without Electron | Built twice: the turn worker (`dist/main/turn-worker.js`) and the container worker (`thread-container-worker.cjs`).                                         |
| Local worker after quit        | Built. A confirmed quit hands each running turn to a worker, and the next launch follows it.                                                                |
| Attach and stop                | Built for local workers over a Unix socket (`turn-worker-socket.ts`): snapshot, chunk stream, stop.                                                         |
| Container run host             | Built. Its own process and socket, survives quit, reattaches on launch. Not yet the same protocol as the turn worker.                                       |
| Unattended decisions           | Deferral mode and the deferred queue exist. The review surface for deferred items (`deferred-approvals.md` D2) is missing.                                  |
| Everything else in the target  | Not built: interactive decisions over the protocol, a worker off this machine, external agents in a worker, the phone attaching to a worker, cloud workers. |

## Phases

Each phase ships on its own and leaves the product better. The order puts the shared pieces
first, so later phases reuse them instead of inventing their own.

### R1. Every local turn in a resident worker

_Unlocks:_ a crash, kill or fault of the app never interrupts a turn. _Owner:_
`local-turn-worker.md`, "Every turn in a turn host" (H1 to H5).

A resident turn host per profile runs every turn from its first step, with the app falling
back to its own loop for anything the host cannot run. This is where the protocol gains its
missing verbs: dispatch a turn, interactive approvals, staged diffs, SSH password prompts,
shared-store writes and profile changes. Container slice C3 lands alongside.

_Exit gate:_ an e2e kills the app's main process mid-turn, relaunches, and sees the turn
finish once with no Retry card. Then the host is on by default.

### R2. One protocol, written down

_Unlocks:_ every later phase talks to a worker the same way. _Owner:_
`client-server-split.md` step 1 (the published schema) and this roadmap.

R1's verbs become a versioned, transport-neutral schema beside the existing API schema
(`dist/schemas/api-protocol.schema.json`). On connect, client and worker exchange versions
and capabilities: which tools the worker has, its sandbox state, and whether it can host
external agents. A client refuses to send a turn to a worker that lacks what the thread
needs. The container run host moves onto this protocol, so its socket stops being a second
dialect.

_Exit gate:_ the turn host and the container run host both pass one conformance suite for
the schema, driven over a plain socket pair.

_State (27 November 2026):_ built. Both hosts open with `hello` and say what
they can run (`worker-protocol/worker-capabilities.ts`): their roles, the kinds of model
beyond Copse's own loop, plugin runtimes and the OS sandbox. The app checks a turn's needs
against what the turn host said before it sends the turn, so a turn that would lose a
plugin's tools or its sandbox stays in the app. The protocol is generated from the line
schemas into `dist/schemas/worker-protocol.schema.json`, with a committed manifest
(`schemas/worker-protocol.manifest.json`, `pnpm run gen:worker-protocol`) of each message's
top-level fields that a test pins.
`worker-conformance.test.ts` drives both hosts over a real local socket with raw lines.
The published schema gives the payloads the line passes on unread (stream chunks, snapshots,
container records) the API protocol's types, and a host's thread prompt the window's command
type less the fields the app adds. A task call is published only as the fields the app checks
before it acts: its full input and result types are not in the API protocol yet. Describing
them in full is open, for R3, before a worker on another machine writes task calls.
The exit gate is met. One part moves to R5: the container run host still reports a run's
progress as its own log and phase lines, and carries the turn stream only once it relays the
guest's loop.

### R3. A worker on the SSH host

_Unlocks:_ an SSH thread keeps running with the laptop closed or asleep. _Owner:_
`cross-device-harness-offload.md` O0 and O2.

Today an SSH thread's loop, approvals and transcript stay on the laptop, and only the tools
run on the host. Here the worker bundle is installed on the host, version-matched to the app,
with the same consent flow the remote file watcher install uses. It runs there, holding the
lease, and the app attaches to its socket through the existing ControlMaster forward.

Two choices need deciding before building:

- **Where the thread lives.** The worker owns the transcript, so the authoritative thread
  files sit on the host. The laptop keeps a read-only mirror that it refreshes on attach, so
  the thread list works offline. Recommended over keeping the store on the laptop, because a
  worker that has to reach the laptop to write has not offloaded anything.
- **Credentials (decided 27 November 2026).** Keys stay on the laptop by default: the
  remote worker's model calls go through the laptop, so a run pauses while it sleeps. The
  user can opt a host in, per provider, to holding a short-lived key scoped to the worker's lease (the
  offload plan's decision 8), and only then does a run carry on with the laptop closed.
  So R3 builds both paths: an inference relay over the forward, as container runs already
  proxy model calls through their host (`host-inference.ts`), and the opt-in key lease.

_Exit gate:_ start a turn on an SSH thread, close the laptop for ten minutes, reopen it, and
find the turn finished once with its transcript complete.

_State._ R3 is built in five steps:

1. **The worker on the host (done).**
   - The turn host is bundled self-contained as `dist/main/ssh-worker.cjs`, with the
     sandbox runtime packed beside it and the OS keychain stubbed out, so it runs on
     the host's own Node (22.13 or later).
   - `src/main/services/ssh-worker/` checks that Node, asks once per app run, uploads
     the build when the host lacks it (to `~/.copse/worker/<build>/`, hash-checked and
     renamed into place whole), starts it detached and forwards a local unix socket to
     the one it serves over the ControlMaster.
   - `tests/e2e/ssh-worker-start.e2e.ts` runs this against the fake SSH host and gets
     the worker's hello over the forward.
   - Nothing sends it turns yet.
2. **The inference relay (done).** The worker starts with `--relay-inference`, so every
   model call it makes (`buildProvider`) goes over the line as `infer` to the app that
   attached last, which builds the provider with its own keys and streams the reply back
   (`turn-host/host-inference-relay.ts`, `turn-host/app-inference.ts`; turn host
   protocol 3). With no app attached a call waits for one, so a turn pauses while the
   laptop sleeps; an app that goes away mid-reply, or goes quiet for 10 minutes (it says
   `infer-alive` each minute while it works), fails that call. The worker keeps at most
   8 calls open and holds the rest; a call too large for the line fails before it is
   sent. The app answers only a host of its own version that said hello on that line,
   and redacts known keys from any error it sends back.
   Each call names the thread whose turn makes it (protocol 4); a call outside a turn is
   not sent. A call goes to the app that sent the turn while that app is attached, else
   to the latest app of the worker's own version: one that only asked the version, or
   never said hello, gets no calls and no turns. The line reader scans each chunk once,
   so a long call costs its length.
   Still open: a relayed provider carries no compaction identity, an error's provider
   status does not cross the line, and model calls that bypass `buildProvider` are not relayed.
3. **SSH thread turns run on the host**, with the thread store there and a mirror kept on
   the laptop (the user's choice, 2026-11-28). In parts:
   - **A profile that outlives builds (done).** Every build serves
     `~/.copse/worker/profile/`, which is the worker's `COPSE_DIR`. The app first only
     asks which version serves it (a `probe` hello). A worker of a newer Copse is left
     alone, and the user is told to update. One of an older Copse is told to retire, and
     the start is retried until this build's answers; its turns wait for an app of its own
     version, which an update leaves none of, so after five tries they are stopped. Builds
     no running process was started from, and not uploaded in the last ten minutes, are
     then removed. Two builds that share a version number (developer builds) count as
     one.
   - **The thread on the host, and turns go there (done, behind Experimental).** With
     "Run each turn in a background process" (Experimental, Background turn host) on, an SSH project's prompt starts its host's
     worker (`ssh-worker/ssh-turn-hosts.ts`), which gets the project as its own, rooted at
     the remote path with no SSH host, so its tools run there directly, and the settings
     the renderer may write, which hold no keys, less those naming other machines or
     carrying an agent's environment (`ssh-worker-seed.ts`). Before each turn the host
     is given the laptop's copy of the thread's history, after the laptop takes the
     host's when the host has more (a turn the worker ran by itself); so a turn the app
     ran while the host was unreachable is kept. The turn streams to the window over the
     forward, and once it ends the laptop's copy is brought up to the host's through the
     thread store. A copy back that still shows the turn running is settled interrupted.
     A second prompt for a thread running there is refused rather than run in the app,
     and so is one while a turn holds the thread's lease there, or when the two copies
     went apart (the user forks it); so the copies never fork silently. A line that
     drops mid-turn waits for the host's lease before the copy back. Stop reaches the
     host, even while the thread is still being given to it. The copy back keeps what
     is the laptop's in the thread's meta: a queued prompt, a draft, links, a rename,
     and anything naming the laptop's worktrees or agents. Nothing the worker sends
     changes the laptop's settings or projects, prompts another thread, records a process
     on the laptop, or answers its SSH logins. A turn the worker cannot take runs in the
     app as before.
   - **What the app answers for the host (done).** The app answers a host's model call
     only for a turn it sent that host, on that turn's model or one of the role models
     its settings name, within 40M estimated tokens and four hours a turn. Questions,
     diff reviews and instruction notices are answered only for that turn's thread and
     project; a question cannot offer workspace trust, and shell output the host sends is
     dropped. A worker that says it cannot run the turn (`turnCannotRunOn`) is given
     nothing of the thread. Commands there still ask the user each time (the worker is
     started with `--commands-unsandboxed`, so it never runs one unasked), and background
     commands are refused with a message saying to run them in the foreground. A thread
     the host still holds after its line went stays running in the list; Stop reaches it
     there, and quitting the app stops every SSH turn. A refused prompt shows why in a
     toast and keeps a queued prompt queued. The two copies are matched by a sync mark
     (`ssh-host-sync.json`): the side that moved since the last copy wins, and both moving
     is refused as a fork.
   - **Still open in step 3:**
     - a turn the worker starts by itself (a wake) is seen at the thread's next turn, not
       live, and a line that reconnects mid-turn does not stream the rest of it;
     - a lost line cannot check the worker's pid, so such a turn is left to the user
       (Continue) rather than guessed;
     - each turn copies the whole thread history both ways, not only what changed;
     - a thread deleted on the laptop stays in the host's store;
     - commands on the host run unconfined once the user allows them, as an SSH thread's
       do today, and background commands do not run there;
     - there is no e2e of a whole turn yet (step 5).
4. **The opt-in key lease.**
5. **The exit gate** as an e2e.

### R4. External coding agents inside the worker

_Unlocks:_ Claude Code, Codex and other ACP agents survive a quit and, on SSH, the laptop
closing. _Owner:_ `acp-session-continuity.md` (phases 1 and 2) and `acp-over-ssh.md`.

The worker hosts the ACP session in place of the app's main process, locally (after R1) and
on the SSH host (after R3). Session resume covers the cases where the agent itself restarts.
This removes the largest remaining "runs in the app only" exception.

_Exit gate:_ an ACP thread keeps running through an app quit and reattaches with its session
intact.

### R5. Container runs become attachable workers

_Unlocks:_ watch, steer or take over a container run while it runs, and switch it between
attended and unattended. _Owner:_ `thread-in-container.md` T2.

The guest already runs the loop. With R2's protocol, the run host becomes a relay: it carries
the protocol between the app and the guest over the existing stdio link, and the guest holds
the thread's lease. Attended runs ask the attached client. Unattended runs defer, as now.

_Exit gate:_ start a container run unattended, attach, answer one approval in the window,
detach, and see the run finish with its commits on the ref.

### R6. Automations run in the worker

_Unlocks:_ schedules and event triggers fire with the app closed. _Owner:_ `automations.md`
and `cross-device-harness-offload.md` O3 and O5.

The automation ticker and the background supervisor move into the resident local worker
from R1. Decisions defer, and the deferred-items review surface (`deferred-approvals.md` D2)
lands here, because unattended runs become common at this point.

_Exit gate:_ a scheduled automation fires and finishes while the app is closed, and its
deferred items are reviewable on the next launch.

### R7. The phone attaches to the worker

_Unlocks:_ watch and answer threads from the phone with the desktop app closed. _Owner:_
`mobile-web-experience.md`.

Today the phone reaches the app's main process, which keeps its renderer alive for it. Here
the phone server talks R2's protocol to the worker, so the app does not need to be running,
only the machine. Pairing, revocation and the relay stay as they are.

_Exit gate:_ with the app closed, the phone streams a running turn live and answers an
approval.

### R8. A worker on a cloud machine

_Unlocks:_ background agents on a machine that is always on. _Owner:_
`copse-cloud-workspaces.md` C1 to C4 and C7.

Provisioning becomes "start a worker on that machine". By this point everything it needs
exists: the protocol (R2), remote install and the remote store (R3), leased credentials (R3)
and unattended decisions (R6). What this phase adds is provisioning, teardown, cost limits
and a deny-by-default egress policy.

_Exit gate:_ C7's: disconnect the desktop during model and tool execution, restart both sides
in adversarial order, and observe one converged task with no duplicate effects.

### R9. Other shells as clients

_Unlocks:_ a lighter desktop shell or a browser tab, with nothing to port in the runtime.
_Owner:_ `client-server-split.md` steps 2 to 4 and `tauri-servo-migration.md`.

Once every turn lives in a worker, the app's main process is a client plus window chrome. A
Tauri or browser shell implements the same client and nothing else.

### R10. Moving a live thread between workers

_Unlocks:_ hand a thread from the laptop to a cloud worker and back. _Owner:_
`cross-device-harness-offload.md` O6.

A lease transition at a turn boundary, with the thread's files copied before the new holder
takes the lease.

## Dependencies at a glance

```text
 R1 local host ──► R2 protocol ──┬─► R3 SSH worker ──┬─► R8 cloud worker ──► R10 hand-off
                                 │                   └─► R4 ACP in worker (on SSH)
                                 ├─► R4 ACP in worker (local)
                                 ├─► R5 container attach
                                 ├─► R6 automations ──► R8
                                 ├─► R7 phone
                                 └─► R9 other shells
```

After R2, R3 to R7 do not depend on each other, except that R4's SSH half needs R3, so they
can be picked in whatever order matters most. The recommended order above puts the laptop
closing (R3) first, because it is the clearest "run anywhere" win.

## Decisions for the user

1. **Thread files for a remote worker live on that machine,** with a read-only mirror on the
   laptop (R3).
2. **Keys stay on the laptop unless the user opts a host in** to a short-lived key scoped
   to the lease (R3, R8). Decided 27 November 2026.
3. **Order after R2.** Recommended: R3 (SSH), then R4, R5, R6, R7, then R8.

## Product areas

| Area                  | Today                                       | After                                     | Phase |
| --------------------- | ------------------------------------------- | ----------------------------------------- | ----- |
| Local threads         | Survive a confirmed quit; a crash cuts them | Survive quit, crash and update            | R1    |
| SSH workspaces        | Loop on the laptop; laptop must stay open   | Laptop can close                          | R3    |
| External ACP agents   | Children of the app; end on quit            | Hosted by the worker, locally or on SSH   | R4    |
| Container runs        | Survive quit; no live attach                | Attach, steer, switch attended/unattended | R5    |
| Automations           | Need the app open                           | Fire with the app closed                  | R6    |
| Phone and web         | Need the app running                        | Need only the machine running             | R7    |
| Cloud workspaces      | Not built                                   | A worker on a provisioned machine         | R8    |
| Other shells          | Prototype runs all of main under a shim     | Client of the worker only                 | R9    |
| Provider cloud agents | Provider runs the loop                      | Unchanged                                 | —     |
