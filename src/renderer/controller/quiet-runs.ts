/**
 * Runs the user launched from the foreground and is sitting there watching.
 *
 * The completion alert (`alerts:threadFinished` → beep / Dock bounce / system
 * notification) exists to pull someone back to a thread they walked away from.
 * A comparison started by clicking a follow-up bubble is the opposite case: the
 * click was a second ago, the card renders in front of them, and chiming at them
 * for it is noise — the same noise the bubble replaced by not raising a spend
 * modal in the first place.
 *
 * A marked thread stays marked only until its next `done`. Every launcher here
 * brackets its run with one (see `retryModelComparison`), including the abort
 * path, so a cancelled run cannot leave the next turn silently muted.
 */
const quietThreads = new Set<string>()

/** Mark this thread's in-flight run as one the user is watching. */
export function markQuietRun(threadId: string): void {
  quietThreads.add(threadId)
}

/** Consume the mark: true when the run that just finished was a quiet one. */
export function takeQuietRun(threadId: string): boolean {
  return quietThreads.delete(threadId)
}
