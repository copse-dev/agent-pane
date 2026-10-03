/**
 * The bench agent talks to Harbor over stdout and must terminate as soon as it has sent its
 * `result` message. Provider SDKs (notably the LM Studio WebSocket client) can leave handles open
 * after a cut prediction, which keeps the Node event loop alive and makes the host wait for EOF
 * until the agent timeout. Exiting explicitly, after stdout has drained, removes that dependency.
 */
export interface ExitStreams {
  readonly write: (chunk: string, callback: () => void) => unknown
}

export interface ExitDeps {
  readonly stdout: ExitStreams
  readonly exit: (code: number) => void
  readonly setTimer: (callback: () => void, ms: number) => { unref?: () => void }
}

export const EXIT_FLUSH_FALLBACK_MS = 2_000

/** Flushes stdout (an empty write completes after earlier queued writes) then exits. */
export function flushAndExit(
  code: number,
  deps: ExitDeps = {
    stdout: process.stdout,
    exit: (exitCode) => process.exit(exitCode),
    setTimer: (callback, ms) => setTimeout(callback, ms),
  },
  fallbackMs: number = EXIT_FLUSH_FALLBACK_MS,
): void {
  let exited = false
  const finish = (): void => {
    if (exited) return
    exited = true
    deps.exit(code)
  }
  // Bounded fallback: a stalled stdout pipe must not reintroduce the hang.
  deps.setTimer(finish, fallbackMs).unref?.()
  deps.stdout.write('', finish)
}
