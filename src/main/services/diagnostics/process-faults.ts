/**
 * Last-line process fault logging.
 *
 * An `fs.watch` `error` (and any other EventEmitter `error` with no listener)
 * becomes an uncaught exception and kills the main process. Watcher sites now
 * bind their own handlers; this module still records anything that escapes so
 * a crash is a log line rather than a silent disappearance, and so shutdown
 * can drain the write queue instead of being SIGKILL'd mid-write.
 *
 * Reporting a fault must never be able to cause one. Logging writes to stdio,
 * and stdio can fail — so a naive handler that logs whatever it is handed will
 * spin forever the moment the failure it is handed IS a failed write (issue
 * #1911, when the launching terminal closes). `createProcessFaultRouter` adds
 * the state that keeps that from happening; `reportProcessFault` stays a
 * stateless one-shot for callers that want to route a fault by hand.
 */

import { isFatalStdioWriteError } from './stdio-guard.ts'

export type ProcessFaultKind = 'uncaughtException' | 'unhandledRejection'

export function formatProcessFault(kind: ProcessFaultKind, fault: unknown): string {
  const text = fault instanceof Error ? (fault.stack ?? fault.message) : String(fault)
  return `[process] ${kind} — ${text}`
}

export interface ProcessFaultHandlerDeps {
  log?: (message: string) => void
  /** Called after an uncaught exception is logged. Should start a graceful quit. */
  onUncaughtException?: (err: unknown) => void
  /** See `ProcessFaultRouterDeps.isLogSinkAlive`. Defaults to always-alive. */
  isLogSinkAlive?: () => boolean
}

export function reportProcessFault(
  kind: ProcessFaultKind,
  fault: unknown,
  deps: Required<Pick<ProcessFaultHandlerDeps, 'log'>> &
    Pick<ProcessFaultHandlerDeps, 'onUncaughtException'>,
): void {
  deps.log(formatProcessFault(kind, fault))
  if (kind === 'uncaughtException') deps.onUncaughtException?.(fault)
}

export interface ProcessFaultRouterDeps {
  log: (message: string) => void
  /** Called once, after the first uncaught exception is routed. Starts the quit. */
  onUncaughtException?: (err: unknown) => void
  /**
   * Consulted before logging. Return false when stdout/stderr can no longer be
   * written, so a fault report does not queue writes that cannot land.
   */
  isLogSinkAlive?: () => boolean
}

/**
 * A fault router that cannot feed itself.
 *
 * Three distinct ways the naive version loops or piles up, each closed here:
 *
 * 1. The fault IS a failed write. Logging it writes again, fails again, and
 *    reports again — forever, at 100% CPU. A write failure is therefore never
 *    logged; there is by definition nowhere to log it to.
 * 2. The sink died after the fault. Same loop, one step removed, so a dead sink
 *    suppresses logging outright.
 * 3. Repeat quits. `onUncaughtException` starts a graceful quit; calling it per
 *    fault re-enters `before-quit` and restarts teardown mid-teardown. It fires
 *    once, and later faults are logged but do not re-trigger it.
 *
 * The `reporting` flag additionally stops synchronous re-entry (a `log` that
 * throws). It cannot stop the asynchronous cases above — by the time a stream's
 * `error` event fires, the call that provoked it has returned and the flag is
 * clear again — which is exactly why cases 1 and 2 are handled by inspection
 * rather than by a guard flag.
 */
export function createProcessFaultRouter(
  deps: ProcessFaultRouterDeps,
): (kind: ProcessFaultKind, fault: unknown) => void {
  let reporting = false
  let quitRequested = false
  return (kind, fault): void => {
    if (reporting) return
    reporting = true
    try {
      const sinkDead = deps.isLogSinkAlive?.() === false
      if (!isFatalStdioWriteError(fault) && !sinkDead) {
        deps.log(formatProcessFault(kind, fault))
      }
      if (kind !== 'uncaughtException' || quitRequested) return
      quitRequested = true
      deps.onUncaughtException?.(fault)
    } finally {
      reporting = false
    }
  }
}

/**
 * Install process-level fault listeners. Idempotent per process: a second call
 * is a no-op so boot and tests cannot stack handlers. Returns a disposer for
 * tests; production leaves the listeners in place for the process lifetime.
 */
let installed = false

export function installProcessFaultHandlers(deps: ProcessFaultHandlerDeps = {}): () => void {
  if (installed) return () => undefined
  installed = true
  const log =
    deps.log ??
    ((message: string): void => {
      console.error(message)
    })
  const route = createProcessFaultRouter({
    log,
    ...(deps.onUncaughtException ? { onUncaughtException: deps.onUncaughtException } : {}),
    ...(deps.isLogSinkAlive ? { isLogSinkAlive: deps.isLogSinkAlive } : {}),
  })
  const onRejection = (reason: unknown): void => {
    route('unhandledRejection', reason)
  }
  const onException = (err: unknown): void => {
    route('uncaughtException', err)
  }
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return () => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
    installed = false
  }
}

/** Test hook — allow a later `installProcessFaultHandlers` after dispose. */
export function resetProcessFaultHandlersForTest(): void {
  installed = false
}
