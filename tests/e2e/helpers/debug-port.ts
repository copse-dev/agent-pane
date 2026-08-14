/**
 * Per-session devtools port allocation for Electron e2e sessions.
 *
 * A devtools port must never be reused inside a worker. Chromium's devtools
 * HTTP handler binds without SO_REUSEADDR, so a loopback connection left in
 * TIME_WAIT by the *previous* session on that port makes the next bind fail —
 * and a live orphaned Electron still holding the port does the same,
 * permanently. Either way the replacement process logs
 *
 *   ERROR:net/socket/socket_posix.cc:175] bind() failed: Address already in use
 *   ERROR:devtools_http_handler.cc:311] Cannot start http server for devtools.
 *
 * then boots fine but *undebuggable*: chromedriver polls /json/version every
 * 10s forever and `POST /session` ends only at wdio's timeout. That is run
 * 31193584160 e2e shard 1, and all 8 shards died the same way. The
 * healthy-but-unadopted Electrons left behind are also where the orphaned ASRT
 * socat bridges (#1599) come from.
 *
 * `beforeSession` runs once per worker, but every spec calls
 * `browser.reloadSession()` and that re-launches Electron from the capabilities
 * captured back then — so a fixed port gets rebound ~25 times per shard, each
 * time onto the port the process it replaces has only just released.
 *
 * Probing for a free port cannot detect this: node sets SO_REUSEADDR on listen,
 * so a probe binds happily over the very TIME_WAIT entry that stops Chromium.
 * Not reusing a port is the property that actually holds.
 */

import { randomInt } from 'node:crypto'

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

const usedDebugPorts = new Set<number>()

/** A port in the range that this worker has not handed out yet. */
export function nextDebugPort(): number {
  if (usedDebugPorts.size >= DEBUG_PORT_COUNT) {
    // 699 sessions in one worker — the oldest TIME_WAIT entries expired long ago.
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
 * Point a session's devtools listener at a fresh port, replacing any
 * `--remote-debugging-port=` the capabilities already carry. Returns the port.
 */
export function assignDebugPort(capabilities: ChromeCapabilities): number {
  const chromeOptions = capabilities['goog:chromeOptions'] ?? {}
  const port = nextDebugPort()
  capabilities['goog:chromeOptions'] = {
    ...chromeOptions,
    args: [
      ...(chromeOptions.args ?? []).filter((arg) => !arg.startsWith('--remote-debugging-port=')),
      `--remote-debugging-port=${port}`,
    ],
  }
  return port
}

/** Test seam: forget the handed-out ports so a case can start from empty. */
export function resetDebugPortsForTest(): void {
  usedDebugPorts.clear()
}
