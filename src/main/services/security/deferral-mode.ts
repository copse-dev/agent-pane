/**
 * Which threads are running unattended, and so answer gates with `defer`
 * instead of a modal (`docs/plans/deferred-approvals.md` Decision 6).
 *
 * Session-only and per-thread, deliberately mirroring `guarded-yolo.ts`: nothing
 * is read from or written to settings, so no migration, restart, or default can
 * switch a run to non-blocking behind the user's back. A consumer that knows
 * nobody is watching — a scheduled automation, a supervised background task, an
 * unattended run — turns it on for the thread it owns and turns it off when the
 * run ends.
 *
 * This is a *mode*, not a policy: it changes what an unavoidable prompt costs,
 * never what is allowed. Everything the gate would deny still denies, and
 * everything it would allow still allows.
 */

const deferringThreads = new Set<string>()
const listeners = new Set<(threadId: string) => void>()

function emit(threadId: string): void {
  for (const listener of listeners) listener(threadId)
}

/** Route this thread's prompts to the review queue until {@link endDeferralMode}. */
export function beginDeferralMode(threadId: string): void {
  if (deferringThreads.has(threadId)) return
  deferringThreads.add(threadId)
  emit(threadId)
}

export function endDeferralMode(threadId: string): void {
  if (!deferringThreads.delete(threadId)) return
  emit(threadId)
}

export function isDeferralModeActive(threadId: string | null | undefined): boolean {
  return typeof threadId === 'string' && deferringThreads.has(threadId)
}

export function onDeferralModeChanged(listener: (threadId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drop every active mode so one spec cannot leak into the next. */
export function clearDeferralModesForTests(): void {
  const active = [...deferringThreads]
  deferringThreads.clear()
  for (const threadId of active) emit(threadId)
}
