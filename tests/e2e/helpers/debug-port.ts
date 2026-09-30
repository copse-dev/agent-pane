/**
 * Per-session devtools port allocation for Electron e2e sessions.
 *
 * A session whose devtools port is already taken never becomes debuggable.
 * Electron logs
 *
 *   ERROR:net/socket/socket_posix.cc:175] bind() failed: Address already in use
 *   ERROR:devtools_http_handler.cc:311] Cannot start http server for devtools.
 *
 * then boots fine, chromedriver polls /json/version until it gives up, and the
 * spec fails in `before all` with "session not created: Chrome instance
 * exited" (PR #3332, run 36765082012, e2e shard 2 — both attempts).
 *
 * What holds the port is a *live listener*, and on Linux it is usually not an
 * Electron. Chromium does not mark its devtools listening socket close-on-exec,
 * and libuv on Linux forks and execs without closing inherited descriptors, so
 * every process the main process spawns carries a copy of the socket. Most die
 * with the app. The gortex daemon does not: `daemon start --detach` reparents
 * it to PID 1, and it keeps the port bound after its Electron exits, without
 * ever accepting on it. (macOS is immune: libuv spawns with
 * POSIX_SPAWN_CLOEXEC_DEFAULT there.)
 *
 * A TIME_WAIT entry left by the previous session is *not* a problem: Chromium
 * binds with SO_REUSEADDR, and a fresh Electron binds straight over one. Both
 * facts were reproduced with Electron 44 in a Linux container.
 *
 * So each candidate port is probed with a real bind before it is handed out,
 * and a port that already has a listener is skipped. The probe matters more
 * than it looks: `usedDebugPorts` below is per *worker*, and wdio forks a new
 * worker for every spec file, so random draws across a shard collide freely —
 * in run 36765082012, worker 0-27 drew 9564 about 70s after worker 0-18's
 * Electron had used it and left a gortex daemon holding it.
 *
 * Rotation within a worker still matters. `beforeSession` runs once per worker,
 * but every spec calls `browser.reloadSession()`, which re-launches Electron
 * from the capabilities captured back then — so a fixed port would be rebound
 * after every reload, each time onto a port a just-exited Electron's children
 * may still be holding (run 31193584160, all 8 shards).
 */

import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'

/**
 * Just the slice of a capabilities object this module touches. Kept structural
 * rather than `WebdriverIO.Capabilities & …` so the helper (and its unit test)
 * typecheck without the wdio ambient types, which only wdio.conf.ts pulls in.
 */
export type ChromeCapabilities = {
  'goog:chromeOptions'?: { args?: string[] }
}

export const DEBUG_PORT_MIN = 9300
export const DEBUG_PORT_MAX = 9999

/** How many distinct ports the range yields (randomInt's max is exclusive). */
const DEBUG_PORT_COUNT = DEBUG_PORT_MAX - DEBUG_PORT_MIN

/**
 * How many held ports to skip before giving up. A shard leaks at most a
 * handful of listeners, so running out means something else owns the range —
 * and a clear error beats a session that never comes up.
 */
export const DEBUG_PORT_MAX_PROBES = 50

/** Chromium binds the devtools server to IPv4 loopback unless told otherwise. */
const DEBUG_PORT_HOST = '127.0.0.1'

const usedDebugPorts = new Set<number>()

/** Whether a port is free to listen on: false while anything is bound to it. */
export type DebugPortProbe = (port: number) => Promise<boolean>

/**
 * Bind the port the way Chromium's devtools server will, then release it.
 *
 * Node listens with SO_REUSEADDR, like Chromium, so this passes over TIME_WAIT
 * entries (which do not stop Chromium either) and fails only on a live
 * listener — exactly the case that leaves a session undebuggable. Any bind
 * error counts as unusable: a port we cannot bind, Chromium cannot either.
 */
export function canListenOnDebugPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.listen({ port, host: DEBUG_PORT_HOST }, () => {
      server.close(() => {
        resolve(true)
      })
    })
  })
}

/** A port in the range that this worker has not handed out yet. */
function drawUnusedDebugPort(): number {
  if (usedDebugPorts.size >= DEBUG_PORT_COUNT) {
    // 699 sessions in one worker — the oldest sessions' children are long gone.
    usedDebugPorts.clear()
  }
  for (;;) {
    const port = randomInt(DEBUG_PORT_MIN, DEBUG_PORT_MAX)
    if (usedDebugPorts.has(port)) continue
    usedDebugPorts.add(port)
    return port
  }
}

/**
 * A port this worker has not handed out yet and that nothing is listening on.
 * Held ports stay marked as used, so a worker never probes the same one twice.
 */
export async function nextDebugPort(
  canListen: DebugPortProbe = canListenOnDebugPort,
): Promise<number> {
  const held: number[] = []
  for (let probe = 0; probe < DEBUG_PORT_MAX_PROBES; probe++) {
    const port = drawUnusedDebugPort()
    if (await canListen(port)) {
      if (held.length > 0) {
        // Leave a trace in the shard log: a skip is the failure this prevents.
        console.warn(
          `[e2e] devtools port(s) ${held.join(', ')} already had a listener ` +
            `(likely a detached child of an earlier session's Electron); using ${String(port)}`,
        )
      }
      return port
    }
    held.push(port)
  }
  throw new Error(
    `No free devtools port in ${String(DEBUG_PORT_MIN)}-${String(DEBUG_PORT_MAX)} after ` +
      `${String(DEBUG_PORT_MAX_PROBES)} probes; every one already had a listener ` +
      `(${held.slice(0, 10).join(', ')}, …). Look for orphaned processes from earlier sessions.`,
  )
}

/**
 * Point a session's devtools listener at a fresh, unbound port, replacing any
 * `--remote-debugging-port=` the capabilities already carry. Returns the port.
 */
export async function assignDebugPort(
  capabilities: ChromeCapabilities,
  canListen: DebugPortProbe = canListenOnDebugPort,
): Promise<number> {
  const port = await nextDebugPort(canListen)
  const chromeOptions = capabilities['goog:chromeOptions'] ?? {}
  capabilities['goog:chromeOptions'] = {
    ...chromeOptions,
    args: [
      ...(chromeOptions.args ?? []).filter((arg) => !arg.startsWith('--remote-debugging-port=')),
      `--remote-debugging-port=${String(port)}`,
    ],
  }
  return port
}

/** Test seam: forget the handed-out ports so a case can start from empty. */
export function resetDebugPortsForTest(): void {
  usedDebugPorts.clear()
}
