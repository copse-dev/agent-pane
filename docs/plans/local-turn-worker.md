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
   quit the user confirmed hands off: a signal (Ctrl+C on `make run`, SIGTERM), a fault quit,
   or a close the dialog let through unanswered (the renderer went away, or two minutes passed)
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
7. **Opt-out setting.** `continueTurnsAfterQuit` turns the hand-off on. It defaults to off
   until Settings offers the switch and Stop reaches a worker's turn, and then to on. With it
   off, quit behaves as in the restart-continuation PR.
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

### W4: stop from the desktop

The Stop button on a worker-held thread signals the worker by its lease pid (same host only),
and the worker aborts the turn. Without this, a handed-off turn can only be stopped by
waiting for it.

### Later

- Start every turn in a worker, so a crash of the app never interrupts a turn (dispatch via
  worker). This needs a live chunk stream from the worker to the desktop (a local socket),
  since file-following alone lags the stream.
- A resident daemon (`client-server-split.md` step 4) replaces per-turn workers.
- A worker on another machine (`cross-device-harness-offload.md` O2).

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
- **Following lags the stream.** A followed thread repaints from disk, so it shows finished
  messages, not tokens as they stream. Fine for a hand-off; not for dispatch via worker.
- **OAuth refreshes the worker cannot save.** A sign-in that refreshes by rotating its
  refresh token would leave the app holding a spent token, because the worker keeps store
  writes in memory. ChatGPT plan models refresh this way, so the worker leaves those turns
  for the next launch. MCP servers that sign in with OAuth have the same gap; a refresh in
  the worker is lost and the app signs in again on next use.
