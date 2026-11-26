# Local turn worker: turns that outlive the app

**Status: Proposed (25 November 2026). Slice W1 in progress.** Step 2 of the plan that
[`cross-device-harness-offload.md`](cross-device-harness-offload.md) and
[`client-server-split.md`](client-server-split.md) step 4 share. It assumes two pieces that
are already in review: the automatic restart continuation (`interrupted-turn-resume.ts`) and
the per-thread writer lease (O1, `writer-lease.ts`).

## The problem left after the restart continuation

Today, after the continuation and the lease:

- **Closing the window** mid-turn detaches it on every platform (`window-detach.ts`). The app
  keeps running until the turn ends.
- **Quitting, crashing or installing an update** still ends the turn. The next launch
  continues it once from the saved history.

The gap is the time between those two events. A quit at 6 pm with the next launch at 9 am
means the work waits all night. This plan keeps the turn going through a quit, without
hosting external CLIs, by running Copse's own loop in a process that is not the app.

## What runs where

```text
 Copse.app (Electron main + renderer)          copse turn worker (one per handed-off turn)
 ────────────────────────────────────          ──────────────────────────────────────────
  user sends ─► AgentDispatcher                 Electron binary, ELECTRON_RUN_AS_NODE=1
                 │ takes writer.lease            running dist/main/turn-worker.js
                 ▼                               │
  quit / update ─► turn stops, lease released    ├─ takes writer.lease (epoch +1)
                 │                               ├─ AgentDispatcher + TurnTranscriptWriter
                 └─ spawns worker (detached) ──► │   write the thread store as usual
                                                 ├─ approvals: deferred (unattended)
  next launch ─► sees live lease held by worker  └─ turn ends ─► lease released, exit
                 ├─ shows the thread as running
                 ├─ follows the thread's files
                 └─ reloads it when the lease is released
```

The worker is the packaged Electron binary with `ELECTRON_RUN_AS_NODE=1`, so it needs no
second runtime and is signed with the app. Its bundle is electron-free, like the container
worker (`dist/main/thread-container-worker.cjs`), which already proves the agent stack loads
without Electron.

## Decisions

1. **One worker per handed-off turn, not a resident daemon.** It is started for one thread
   and exits when that turn ends. There is nothing to supervise, upgrade or shut down. A
   resident daemon (`client-server-split.md` step 4) can replace it later behind the same
   lease and attach contract.
2. **Hand-off happens at a turn boundary.** A live provider stream cannot move between
   processes. On quit the desktop stops the turn as it does today. The worker then runs the
   same restart continuation a relaunch runs after a crash (`INTERRUPTED_TURN_CONTINUATION`,
   budget-charged, once per interruption). So the worker reuses semantics that are already
   reviewed, rather than inventing a second resume path. A quit that hands off is recorded
   as `hand-off` in `last-run.json` (hooks plan decision 5), so a turn no worker took, because
   the worker declined it or never started, is continued by the next launch instead. Only a
   quit the user confirmed hands off: a signal (Ctrl+C on `make run`, SIGTERM) or a fault quit
   has nobody to confirm it, so it stops the run and is recorded as `quit`.
   The worker runs only Copse's own loop. A thread on an external coding agent (ACP) or a
   remote agent is left for the next launch, because the worker could not stop that agent or
   the processes it starts once it exits.
3. **The writer lease is the only ownership signal.** The desktop releases the lease when its
   turn stops, and the worker takes it before writing. A desktop that relaunches while the
   worker runs finds the lease live, so its own boot continuation gets `AgentTurnBusyError`
   and skips the thread. The renderer must not stamp `interruptedTurnAt` on a thread whose
   lease another live process holds.
4. **The worker reads the profile and never writes shared stores.** `config.json` (settings,
   projects) is one JSON file that each process caches and rewrites, so two writers would lose
   each other's changes. The worker loads settings and projects read-only, and writes only
   inside the thread directory it holds the lease for.
5. **Credentials come from the keyring cipher.** API keys sealed with the shell-neutral
   keyring cipher (`keyring-cipher.ts`) open without Electron. A key still sealed by
   `safeStorage` cannot be read. In that case the worker exits without taking the lease, and
   the next launch continues the turn as it does today.
6. **Unattended approvals defer.** Nobody is watching the worker. Anything the permission
   policy would ask about is deferred with the existing deferral mode (`deferral-mode.ts`,
   used by scheduled automation runs), not approved. The deferred items surface on the thread
   when the desktop returns (`deferred-approvals.md`).
7. **Opt-out setting.** `continueTurnsAfterQuit` turns the hand-off on. It defaulted to off
   until Settings offered the switch ("When Copse closes", in Agent settings) and Stop
   reached a worker's turn, and is on now. With it off, quit behaves as in the
   restart-continuation PR. It covers container runs as well as turns.
8. **Never for an update that changes the store format.** The worker must not run against a
   thread store whose format is newer than it understands. The worker is the quitting app's
   own binary, so this only matters if a later change starts workers from another version.
   _Not implemented yet:_ the store has no format version to compare, so the guard lands
   with the first format change. Until then a quit that installs an update (a downloaded
   update installs on any quit, and "Restart now") starts no worker at all: the updater
   replaces the binary a worker would run from, and the relaunched version continues the
   turns itself.

## Slices

### W1: worker entry, run one continuation headless

- `src/main/services/turn-worker/turn-worker-entry.ts`, bundled to `dist/main/turn-worker.js`.
- Arguments: profile directory, project id and thread id. It boots the profile read-only:
  the store backend, the keyring cipher and settings.
- It runs the restart continuation for that one thread through `resumeInterruptedTurns`,
  with a dispatcher whose transcript sink is the main-owned `TurnTranscriptWriter`. The lease
  comes from the dispatcher's default `claimWriter`.
- Logs to `<profile>/logs/turn-worker-<thread>.log`. Exits 0 when the turn ends or the thread
  is not resumable, and non-zero on a boot failure.
- _Exit gate:_ a unit test that bundles the entry, runs it with Node against a seeded temp
  profile and the mock provider, and finds the continuation and its answer on the thread's
  spine, the lease released and the thread `idle`.

### W2: hand off on quit

- `cleanupBeforeQuit` reads the dispatcher's active turns (`activeTurns()`) before it stops
  them, and once the transcripts and the write queue have drained it spawns one worker per
  turn (`turn-worker-launch.ts`): detached, `stdio` to the log, `unref()`. Which of them
  can continue is the worker's call, through the same `resumeInterruptedTurns` filter
  (side chats, automations and explicit-agent turns are left alone).
- Skipped when the setting is off. Decision 8 has nothing to compare yet.
- _Exit gate:_ e2e. Quit mid-turn, assert a worker process holds the thread's lease and the
  continuation reaches the thread's files while no app is running.

### W3: reattach on launch

- `ForeignTurnFollower` (`foreign-turns.ts`) finds running threads whose live lease another
  process holds. `agent:running-thread-ids` includes them, so the renderer's
  `resumePendingQueues` leaves them `running` instead of stamping them interrupted.
- Main repaints a followed thread from disk every two seconds through the existing
  `agent:transcript-snapshot` channel, and once more after the lease is released, which
  settles it.
- The boot continuation skips followed threads, and the dispatcher would refuse them anyway
  (decision 3).
- _Exit gate:_ e2e. Relaunch while a worker runs, see the thread running with output
  arriving, then settling with no Retry card and no second continuation.

### W4: attach and stop from the desktop

- The worker first checks, from the read-only profile and the thread files, that it would
  continue the thread at all (the resume rules and the model checks above). Only then does it
  take the thread's lease, before its slow boot, so an app relaunched meanwhile follows it
  instead of continuing the turn too; a thread the worker declines is never held.
- The turn runs under that same claim, and the worker gives the lease back only after the
  turn's last write has landed and its socket has closed, so nothing else starts on the
  thread under that write.
- From the takeover until it exits, the worker serves the thread on a local socket (`turn-worker-socket.ts`): a
  Unix socket under `<profile>/run/` (a named pipe on Windows), named by a hash of the profile
  and thread, newline-delimited JSON. `attach` replies with the turn's runtime snapshot and
  then streams every stamped chunk, the same order an in-process turn reaches the window.
  `stop` aborts the turn as Stop does in-process. A stop that arrives during the boot is
  kept: the continuation then never starts, and the thread is settled interrupted, so the
  window offers Continue.
- The app's follower attaches to that socket and forwards into `agent:transcript-snapshot`
  and `agent:chunk`, so a handed-off turn streams live. Without an answer there (an older
  worker, or one just starting) it repaints from disk as in W3. A window reload re-sends
  `attach`. Stop on a followed thread goes to the worker; pressed before the worker answers,
  it is sent as soon as it does. A thread whose worker died without releasing its lease is
  settled interrupted rather than left spinning.
- Not covered by e2e yet: a live attach needs a worker turn slow enough to outlast a
  relaunch, and mock scenarios live in the app process.

### SSH hosts

A turn on an SSH project needs nothing new to be handed off: its tools already reach the host
through the OpenSSH transport, which connects on first use. The worker reads the saved hosts
from the read-only profile and opens the connection itself, on the same per-host control
socket the app uses (`ssh-paths.ts`), so whichever process comes second reuses the master
instead of authenticating again. `turn-worker-ssh.test.ts` pins this with the e2e suite's stub
`ssh`: a cut-off turn on an SSH project lists the remote directory from the worker.

- **Password and passphrase prompts fail closed.** The askpass bridge lives in the app, and
  the worker serves none. The worker also drops the user's own `SSH_ASKPASS` and sets
  `SSH_ASKPASS_REQUIRE=never` before anything connects (`worker-environment.ts`), so a host
  that needs a typed secret fails the turn's first remote command instead of opening a system
  password dialog nobody expects. Key, agent and a still-live master all work.
- **The master outlives the worker,** as it outlives the app today (`ControlPersist`, four
  hours), so the relaunched app picks it up without a new handshake.
- **Remote commands do not.** Before it exits the worker runs the app's quit teardown, which
  kills the remote process groups of the background commands it started while the master is
  still up, so nothing it started keeps running on the host unseen.

### Later

- Start every turn in a worker, so a crash of the app never interrupts a turn (dispatch via
  worker). This needs a live chunk stream from the worker to the desktop (a local socket),
  since file-following alone lags the stream.
- A resident daemon (`client-server-split.md` step 4) replaces per-turn workers.
- A worker on another machine (`cross-device-harness-offload.md` O2).

## Container runs

A container run (`thread-in-container.md`) already keeps Copse's own loop off the desktop: the
agent runs in the guest. What still ties the run to the app is its host side, all of which
lives in the app's main process today (`runThreadInContainer` in `thread-container.ts`):

- the guest's stdio link, from `docker start --attach --interactive`. It carries the egress
  broker's framed connections and the one-time key hand-over (`egress-link.ts`, decision A17).
- the egress broker that dials the allowlisted origins for the guest (`egress-broker.ts`).
- host inference: the provider the guest's model calls are proxied to, built in the host so an
  OAuth token never enters the guest (`host-inference.ts`).
- the wait, the wall-clock deadline, carry-out (`git fetch` of the guest's bundle), teardown and
  `record.json`.

When the app quits, the stdio pipes close, so the guest loses its network and its model. The
run cannot be re-attached later either: the link is a framed byte stream with no resync point.
`ContainerRunService.stopAll` therefore stops every run on quit, and the next launch sweeps
what is left.

So, unlike a chat turn, a container run cannot be handed off at quit. Its host side has to
start out of the app.

### Decisions

1. **A run host process per run, started with the run.** `ContainerRunService.drive` keeps
   everything it does today up to the runner call: arming, provider choice, budgets, the
   checkout, the supervisor task and the decision-log entry. It then starts
   `dist/main/container-run-host.js` the same way the turn worker starts (the app binary under
   `ELECTRON_RUN_AS_NODE`, detached, logging to `<profile>/logs/`). That process calls
   `runThreadInContainer` and owns the stdio link until the run ends.
2. **The host process resolves the provider itself.** `hostInference` is a factory, and the
   key must not travel through argv, the environment or a file, so the app hands over only
   serialisable inputs: model id, `useAgentLogin`, workspace, prompt, carry-in ref, budgets,
   install choice, engine, runtime id and egress allowlist. The host boots the profile
   read-only with the keyring cipher (as the turn worker does) and calls
   `resolveContainerProvider` again. If the egress it gets differs from what the app armed, it
   refuses to run. A provider whose sign-in can rotate a refresh token on refresh (ChatGPT
   plan) would lose the new token in a read-only host, so such a run stays in the app as it
   does today and stops on quit. So does a run on a profile whose stored keys only
   `safeStorage` can open (no OS keyring, so they were never moved to the keyring cipher):
   the host could not open them. The rest of the app's environment still reaches the host,
   as it reached the engine CLI before, so a key that exists only there travels with it.
3. **Progress travels over the run's socket.** Like the turn worker's (`turn-worker-socket.ts`):
   the host streams phase and log lines and, at the end, the record, and takes `stop`.
   `<profile>/container-hosts/<runtime id>.json` names the host's pid and socket, so a
   relaunched app finds live runs without the supervisor. The host is started in its own
   process group; when the app loses it without a result (it died, or never listened), the
   app ends that group and cleans up what the runner would have: the container and the
   staged copy of the user's sign-in.
4. **Quit leaves host runs alone.** `stopAll` skips runs whose host process is alive. The
   supervisor task is moved out of the shutdown cancel. Today shutdown cancels every running
   external task with a process handle, which would force-remove the container. Instead the
   task records that the run continues outside the app, and the relaunched app settles it
   from the record.
5. **Relaunch reattaches from the host file.** At start-up, after the orphan sweep (which already
   skips running containers), the service lists run directories with a live host. It connects
   to each one, and puts its progress back in `runs`, so the banner, the dialog and Stop work
   as before. A host that died leaves `record.json`, or nothing; the run then settles as
   failed with what the record says.

### Slices

- **C1, run host process.** The entry, the bundle entry, the socket, and `drive` delegating to
  it. A run the app started finishes the same way, through the host. Exit gate: the container
  run e2e passes with the host in between.
  Status: built. `run-host.ts` is the host, `run-host-client.ts` the app's end,
  `run-host-entry.ts` the bundle entry (`dist/main/container-run-host.js`), and the local
  line is shared with the turn worker (`local-socket.ts`). The bundled host boots on a
  fresh profile, resolves its provider and refuses changed egress; the container e2e
  through it is still to run. Until C2, the host treats an app that leaves before the run
  ends (its line closes), or one that never attaches within the app's 30 s connect
  deadline, as a stop: nothing could see or stop the run otherwise, and decision A8 of
  `thread-in-container.md` (an orphaned run winds itself down) keeps holding for the app.
- **C2, survive quit.** `stopAll` and supervisor shutdown leave host runs alone, and
  relaunch reattaches from the host file. C2 drops C1's stop-when-the-app-leaves rule.
  Exit gate: quit mid-run, relaunch, and see the run
  finish once with its commits on the ref.
  Status: built. `stopAll` lets go of host runs when `continueTurnsAfterQuit` is on (the
  client's `detach`), and every other run stops as before. The supervisor's external-task
  lifetime hooks keep the run's task running through shutdown (`survivesShutdown`) and
  through the restart reconcile while its host is alive (`isAlive`). After the supervisor
  loads, `reattach` follows each live `container-hosts/<runtime>.json` and settles the
  run and its task as if this session had started it.
  A host that ends with no app attached keeps its file and writes how the run ended into it
  (`ended`), so a relaunch after the run finished settles the run and its task from that,
  and the settled listeners record it in the thread. A host that was killed without saying
  (`lost`: its pid is gone and there is no `ended`) settles as failed, and the app removes
  its container and staged sign-in. The host stops its run on SIGTERM, SIGHUP and SIGINT,
  so a logout or shutdown runs the runner's own cleanup. The app removes a host file once
  it has settled the run, and also when following it fails, so a file whose pid now
  belongs to another process is tried once. Quits nobody chose (signals, faults) and quits
  that install an update stop container runs instead of letting them go, as for turns, and
  so does a run the user already asked to stop. The close dialog names container runs
  alongside working threads.
- **C3, settle without the app.** When no app is attached at the end, the host records the
  run in the thread's model history itself (`recordContainerRunTurn`, which the app runs from
  `onSettled` today). Without this step, the next message to the thread does not know what
  the run did until the app has seen it settle.

## Risks

- **Two writers on shared stores.** Covered by decision 4. A worker that writes
  `config.json` would silently drop desktop changes, so the entry installs a store backend
  that reads the profile once and keeps writes in memory, logging each key it could not
  keep. A test pins that the file is never written.
- **Lease gaps on store writes.** O1 still lacks epoch checks at write sites. A worker that
  loses its lease (for example to a desktop forced to take over after expiry) can finish one
  in-flight write. Acceptable for W1–W3, because the desktop never takes over a live worker's
  lease; it waits.
- **Orphaned workers.** A worker whose turn hangs holds its lease while it heartbeats. The
  turn's own step and time limits bound it, and W4 gives the user a stop.
- **Platform launch.** macOS: the child of an app that quits survives if it is detached and
  in its own process group. Linux: same, with `setsid` semantics from `detached: true`.
  Windows is low priority and not covered by W2's exit gate.
- **The `RunAsNode` fuse.** The worker runs the app binary with `ELECTRON_RUN_AS_NODE=1`.
  A packaged build that flips that fuse off (computer use asks for it) breaks the worker and
  the other Node workers that launch the same way. Such a build needs a separate Node
  binary or a utility process kept alive past quit instead.
- **Following without the socket lags the stream.** When the worker cannot be reached, a
  followed thread repaints from disk and shows finished messages, not tokens as they stream.
- **OAuth refreshes the worker cannot save.** A sign-in that refreshes by rotating its
  refresh token would leave the app holding a spent token, because the worker keeps store
  writes in memory. ChatGPT plan models refresh this way, so the worker leaves those turns
  for the next launch. MCP servers that sign in with OAuth have the same gap; a refresh in
  the worker is lost and the app signs in again on next use.
