/**
 * Per-thread record of sandbox operations confirmed denied this run (issue
 * #1436 point 2). Keyed by an operation descriptor (`git fetch`, `read
 * ~/.config/gh`, …) — never by tool name and never by a blanket category like
 * "the network" — so a denied `git fetch` never becomes a belief that `git
 * push` (a different operation, over the same tool) is blocked too.
 *
 * Session-only, like `guarded-yolo.ts`'s registry: nothing here is persisted,
 * so a restarted app starts with a clean slate and re-learns what is actually
 * blocked rather than trusting stale advice.
 */

export interface DeniedOperationEntry {
  /** The command whose failure confirmed this operation is denied. */
  command: string
  /** Advisory text naming the operation, suitable to show the model again. */
  advice: string
  at: number
}

const NO_THREAD_KEY = '_no-active-thread'

class DeniedOperationRegistry {
  private readonly byThread = new Map<string, Map<string, DeniedOperationEntry>>()

  /** Record that `operation` was confirmed denied for `threadId` (or the ambient run when null). */
  record(threadId: string | null, operation: string, command: string, advice: string): void {
    const key = threadId ?? NO_THREAD_KEY
    let operations = this.byThread.get(key)
    if (!operations) {
      operations = new Map()
      this.byThread.set(key, operations)
    }
    operations.set(operation, { command, advice, at: Date.now() })
  }

  /** The cached entry for this exact operation, or undefined when it was never seen. */
  get(threadId: string | null, operation: string): DeniedOperationEntry | undefined {
    return this.byThread.get(threadId ?? NO_THREAD_KEY)?.get(operation)
  }

  isDenied(threadId: string | null, operation: string): boolean {
    return this.get(threadId, operation) !== undefined
  }

  /** Test/teardown hook — never called from production code. */
  clearThread(threadId: string | null): void {
    this.byThread.delete(threadId ?? NO_THREAD_KEY)
  }
}

/** Module-level singleton: one process, one set of threads, like GuardedYoloRegistry. */
export const deniedOperations = new DeniedOperationRegistry()

/**
 * Advice for `operation` if — and only if — this exact operation was already
 * confirmed denied earlier in this thread. Returns null for any other
 * operation, including a different action on the same command/tool (e.g. a
 * `git push` after a denied `git fetch`), so an unrelated operation is never
 * reported as blocked (issue #1436 point 2).
 */
export function cachedDenialAdvice(threadId: string | null, operation: string): string | null {
  const entry = deniedOperations.get(threadId, operation)
  if (!entry) return null
  return `${entry.advice} (Already confirmed denied earlier in this thread by \`${entry.command}\`.)`
}
