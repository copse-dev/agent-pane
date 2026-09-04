/**
 * Keep a hung-up stdout/stderr from livelocking the main process (issue #1911).
 *
 * When the terminal that ran `make run` closes, the kernel hangs up the pty and
 * every later write to stdout/stderr fails with EIO. Node surfaces that failure
 * asynchronously, as an `error` event on the stream, which `console.*` cannot
 * swallow — by the time it fires the console call has long returned. An `error`
 * event with no listener is an uncaught exception, so it reaches the
 * process-fault handler, which logs it with `console.error`, which writes to the
 * same dead stream, which fails with EIO again. Measured on a real run: the main
 * process spins at ~100% CPU on that cycle, starves the event loop so the
 * shutdown it just started never finishes, and survives everything but SIGKILL.
 *
 * Binding a listener is what breaks the cycle — the EIO is delivered here
 * instead of becoming a fault. Once a stream is known dead we also stop
 * advertising it as a log sink, so shutdown is not spending a doomed syscall per
 * line on the way out.
 *
 * Deliberately not a console patch: replacing the global would change behaviour
 * for every caller in the process to fix one failure mode. Callers keep logging
 * exactly as before; their writes simply fail harmlessly instead of detonating.
 */

/**
 * Write failures that mean the far end is gone for good, rather than a blip:
 * the pty was hung up (EIO), the reader closed the pipe (EPIPE), the descriptor
 * is no longer valid (EBADF/ENXIO), or Node already tore the stream down
 * (ERR_STREAM_DESTROYED). Anything else is swallowed but does not mark the
 * stream dead, so one transient error cannot silence logging for the session.
 */
export const FATAL_STDIO_WRITE_CODES: ReadonlySet<string> = new Set([
  'EBADF',
  'EIO',
  'ENXIO',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
])

export function isFatalStdioWriteError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' && FATAL_STDIO_WRITE_CODES.has(code)
}

/** The slice of a stdio stream this guard needs. Narrow so tests can fake it. */
export interface ErrorEmittingStream {
  on(event: 'error', listener: (err: unknown) => void): unknown
  off(event: 'error', listener: (err: unknown) => void): unknown
}

export interface StdioGuard {
  /**
   * False once every guarded stream has failed fatally — there is nowhere left
   * for a log line to land, so callers may skip the attempt.
   */
  isLogSinkAlive(): boolean
  /** How many guarded streams have died. Exposed for assertions/diagnostics. */
  deadStreamCount(): number
  dispose(): void
}

export interface StdioGuardDeps {
  /**
   * Called once, the first time a guarded stream fails fatally. Swallowing the
   * error must not also swallow its meaning: a dead stdout is how a headless
   * run learns its client has gone (ACP speaks its protocol over stdout, and
   * before this guard existed the resulting EPIPE crashed the process out).
   * The handler is expected to start a graceful quit — quietly, without
   * logging, since the stream it would log to is the one that just died.
   */
  onSinkLost?: (err: unknown) => void
}

/**
 * Guard a specific set of streams. Pure wiring — no process globals — so the
 * behaviour can be driven directly from tests.
 */
export function createStdioGuard(
  streams: readonly ErrorEmittingStream[],
  deps: StdioGuardDeps = {},
): StdioGuard {
  const dead = new Set<ErrorEmittingStream>()
  const bound: Array<{ stream: ErrorEmittingStream; listener: (err: unknown) => void }> = []
  let sinkLostReported = false

  for (const stream of streams) {
    const listener = (err: unknown): void => {
      // The error itself is swallowed on purpose. This listener exists so the
      // `error` event has an owner; reporting it would mean writing to the very
      // stream that just failed, which is the loop this module exists to
      // prevent. What the failure *means* is escalated once, via `onSinkLost`.
      if (!isFatalStdioWriteError(err)) return
      dead.add(stream)
      if (sinkLostReported) return
      sinkLostReported = true
      deps.onSinkLost?.(err)
    }
    stream.on('error', listener)
    bound.push({ stream, listener })
  }

  return {
    isLogSinkAlive: (): boolean => dead.size < streams.length,
    deadStreamCount: (): number => dead.size,
    dispose: (): void => {
      for (const { stream, listener } of bound) stream.off('error', listener)
      dead.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton (real stdout/stderr).
// ---------------------------------------------------------------------------

let installed: StdioGuard | null = null

/**
 * Guard the real stdout/stderr. Idempotent per process: a second call is a
 * no-op so boot and tests cannot stack listeners. Returns a disposer for tests;
 * production leaves the guard in place for the process lifetime.
 */
export function installStdioGuard(deps: StdioGuardDeps = {}): () => void {
  if (installed) return () => undefined
  const guard = createStdioGuard([process.stdout, process.stderr], deps)
  installed = guard
  return () => {
    guard.dispose()
    installed = null
  }
}

/**
 * False once both stdout and stderr are known dead. Returns true when no guard
 * is installed — an uninstrumented process must never be assumed mute.
 */
export function isLogSinkAlive(): boolean {
  return installed?.isLogSinkAlive() ?? true
}
