/**
 * Last-line process fault logging.
 *
 * An `fs.watch` `error` (and any other EventEmitter `error` with no listener)
 * becomes an uncaught exception and kills the main process. Watcher sites now
 * bind their own handlers; this module still records anything that escapes so
 * a crash is a log line rather than a silent disappearance, and so shutdown
 * can drain the write queue instead of being SIGKILL'd mid-write.
 */

export type ProcessFaultKind = 'uncaughtException' | 'unhandledRejection'

export function formatProcessFault(kind: ProcessFaultKind, fault: unknown): string {
  const text = fault instanceof Error ? (fault.stack ?? fault.message) : String(fault)
  return `[process] ${kind} — ${text}`
}

export interface ProcessFaultHandlerDeps {
  log?: (message: string) => void
  /** Called after an uncaught exception is logged. Should start a graceful quit. */
  onUncaughtException?: (err: unknown) => void
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
  const onRejection = (reason: unknown): void => {
    reportProcessFault('unhandledRejection', reason, { log })
  }
  const onException = (err: unknown): void => {
    reportProcessFault('uncaughtException', err, {
      log,
      ...(deps.onUncaughtException ? { onUncaughtException: deps.onUncaughtException } : {}),
    })
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
