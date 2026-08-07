/**
 * Give every Electron session its own `--remote-debugging-port`.
 *
 * `beforeSession` in wdio.conf.ts picks the debug port **once per worker**, and
 * `browser.reloadSession()` does not re-run that hook — it reuses
 * `instance.requestedCapabilities` verbatim. So the Electron that `reloadSession`
 * launches is handed the port the outgoing Electron is still shutting down on.
 *
 * That is not a benign race, it is the whole failure. Time-ordered chromedriver
 * logs from run 31198698692 show it in every worker (0-6 :9760, 0-7 :9821,
 * 0-8 :9902, 0-9 :9521):
 *
 *     t+ 0.0s  Launching chrome …
 *     t+ 0.0s → t+0.6s   DevTools -> :9760   x12, instant refusals, then connects
 *     t+ 6.1s  Launching chrome …            (reloadSession)
 *     t+ 6.1s  DevTools -> :9760
 *     t+16.1s  DevTools -> :9760             <- 10s hang
 *     t+26.2s  DevTools -> :9760             <- 10s hang
 *
 * The two phases fail differently, and that difference is the diagnosis. A port
 * with nothing on it *refuses* immediately — that is the first twelve polls,
 * while the app boots. A port whose listener is a process on its way out accepts
 * the SYN and never answers, so chromedriver waits out its own 10s budget each
 * time. Three of those exhausts `connectionRetryTimeout` (30s in
 * wdio.ci.conf.ts), `POST /session` is aborted, and the spec dies in `before all`
 * having reported a near-constant 35.2s.
 *
 * It is deterministic rather than flaky: every spec calling `reloadSession`
 * fails, and the sole survivor on a shard is whichever spec never reloads
 * (`titlebar-compact.e2e.ts`, whose `before` only waits for `#titlebar`). Hence
 * "1 passed, N failed" recurring with the same 1.
 *
 * Only visible after the unscoped `pkill -f chromedriver` was removed: killing
 * the driver used to produce ECONNREFUSED before anything could hang.
 */

import { createServer } from 'node:net'

/** The flag Chromium reads for its DevTools endpoint. */
const DEBUG_PORT_FLAG = '--remote-debugging-port'

/**
 * Ask the kernel for a free ephemeral port and release it.
 *
 * Preferred over picking a number at random: random collides silently and the
 * symptom (a 10s DevTools hang) looks nothing like "port in use". Inherently
 * advisory — the port is unbound when we return it — but the window is
 * microseconds against the seconds-long one this replaces.
 */
export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Could not determine a free port'))
        })
        return
      }
      const { port } = address
      server.close(() => {
        resolve(port)
      })
    })
  })
}

/**
 * Replace any `--remote-debugging-port=…` in `args` with `port`, appending it
 * when absent. Pure, so the rewrite is testable without a browser.
 */
export function withRotatedDebugPort(args: readonly string[], port: number): string[] {
  const rotated = args.filter((arg) => !arg.startsWith(`${DEBUG_PORT_FLAG}=`))
  rotated.push(`${DEBUG_PORT_FLAG}=${String(port)}`)
  return rotated
}

type ChromeOptions = { args?: string[] }

export type SessionReloader = {
  requestedCapabilities?: Record<string, unknown>
  /**
   * WDIO's supported command override. Required for the same reason
   * `installDeleteSessionSafety` needs it: under `@wdio/globals` the exported
   * `browser` is a Proxy with no `set` trap, so plain assignment never reaches
   * the real instance.
   */
  overwriteCommand?: (
    name: string,
    fn: (
      this: unknown,
      origCommand: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => unknown,
  ) => void
}

const reloadSessionPatched = new WeakSet<object>()

/**
 * Rotate the debug port into `requestedCapabilities` before each
 * `reloadSession`, so the incoming Electron never inherits the outgoing one's.
 *
 * A caller passing explicit capabilities to `reloadSession(caps)` is left alone
 * — that is a deliberate override and WDIO ignores `requestedCapabilities` on
 * that path anyway.
 */
export function installReloadSessionPortRotation(
  session: SessionReloader,
  options?: { freePort?: () => Promise<number> },
): void {
  if (reloadSessionPatched.has(session)) return
  reloadSessionPatched.add(session)

  const freePort = options?.freePort ?? findFreePort

  const rotate = async (args: unknown[]): Promise<void> => {
    // Explicit capabilities: caller's choice wins, nothing to rotate.
    if (args.length > 0 && args[0] !== undefined) return
    const chromeOptions = session.requestedCapabilities?.['goog:chromeOptions'] as
      ChromeOptions | undefined
    if (chromeOptions?.args === undefined) return
    chromeOptions.args = withRotatedDebugPort(chromeOptions.args, await freePort())
  }

  if (typeof session.overwriteCommand === 'function') {
    session.overwriteCommand(
      'reloadSession',
      async function overwriteReloadSession(
        this: unknown,
        origReloadSession: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) {
        await rotate(args)
        return await origReloadSession.apply(this, args)
      },
    )
  }
}
