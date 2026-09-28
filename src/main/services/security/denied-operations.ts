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

  /** Drop denial evidence when a thread is deleted or a test resets it. */
  clearThread(threadId: string | null): void {
    this.byThread.delete(threadId ?? NO_THREAD_KEY)
  }
}

/** Module-level singleton: one process, one set of threads, like GuardedYoloRegistry. */
export const deniedOperations = new DeniedOperationRegistry()

/**
 * Remember output-derived denial evidence only after its escalation was
 * approved. Keeping the approval and mutation in one helper prevents a declined
 * prompt from changing how the next invocation is routed.
 */
export function recordApprovedDeniedOperation(
  approved: boolean,
  threadId: string | null,
  operation: string,
  command: string,
  advice: string,
): void {
  if (!approved) return
  deniedOperations.record(threadId, operation, command, advice)
}

/**
 * Cap for the *display* of a prior command cited in a denial note. The live
 * command under review is truncated separately; this only keeps a long multi-
 * line script from blowing up the "earlier in this thread" block. Never fed
 * back into markdown/backticks that could splice into the live command.
 */
export const CACHED_DENIAL_COMMAND_DISPLAY_MAX = 120

/**
 * Single-line, quote-safe preview of a previously denied command for UI copy.
 * Newlines become spaces so a multi-line script cannot break a bullet or run
 * into surrounding prose; length is capped so the note stays scannable.
 */
export function formatCachedDenialCommandForDisplay(
  command: string,
  maxChars: number = CACHED_DENIAL_COMMAND_DISPLAY_MAX,
): string {
  const singleLine = command.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxChars) return singleLine
  const remaining = singleLine.length - maxChars
  return `${singleLine.slice(0, maxChars)}… (+${String(remaining)} more characters)`
}

/**
 * Structured prior-denial note for the approval UI. Kept separate from the live
 * command and from reason bullets so a long prior script cannot concatenate into
 * either. Prefer this over {@link cachedDenialAdvice} when building prompts.
 */
export interface CachedDenialNote {
  /** Operation-specific denial sentence (no prior-command splice). */
  advice: string
  /** Single-line truncated prior command that confirmed the denial. */
  priorCommandDisplay: string
  /**
   * Full prose for places that still take a single string (model-facing notes,
   * tests). Uses plain quotes, never markdown backticks.
   */
  text: string
}

/**
 * Marker substring used by prompt formatters to pull a cached-denial reason out
 * of a mixed reasons array and render it as its own block (not a bullet that
 * also holds the live command).
 */
export const PRIOR_DENIAL_MARKER = 'Earlier in this thread: already confirmed denied'

/**
 * Prior-denial note for `operation` if — and only if — this exact operation was
 * already confirmed denied earlier in this thread. Returns null for any other
 * operation, including a different action on the same command/tool (e.g. a
 * `git push` after a denied `git fetch`), so an unrelated operation is never
 * reported as blocked (issue #1436 point 2).
 */
export function cachedDenialNote(
  threadId: string | null,
  operation: string,
): CachedDenialNote | null {
  const entry = deniedOperations.get(threadId, operation)
  if (!entry) return null
  const priorCommandDisplay = formatCachedDenialCommandForDisplay(entry.command)
  return {
    advice: entry.advice,
    priorCommandDisplay,
    text:
      `${entry.advice}\n\n${PRIOR_DENIAL_MARKER} ` + `(matched command: "${priorCommandDisplay}").`,
  }
}

/**
 * Flat string form of {@link cachedDenialNote} for callers that only need prose
 * (e.g. legacy reason arrays). Never wraps the prior command in backticks.
 */
export function cachedDenialAdvice(threadId: string | null, operation: string): string | null {
  return cachedDenialNote(threadId, operation)?.text ?? null
}
