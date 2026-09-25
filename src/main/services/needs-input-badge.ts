/**
 * The Dock/taskbar badge: how many threads are waiting on the user.
 *
 * Definition: the number of distinct threads with at least one open approval
 * prompt or `ask_user` question, across every window, whether or not that
 * thread is on screen. A prompt not attributed to any thread counts on its own.
 * The badge exists for a user who is looking elsewhere, so the focused thread's
 * open prompt counts too — unlike the sidebar bell, which only flags threads
 * the user is not already looking at.
 *
 * The main process owns the count because it owns the prompts: a hold is taken
 * when a needs-input alert is raised and released by the same stop callback
 * the prompt already runs when it settles for any reason — answered, aborted
 * by Stop, torn down with its thread on deletion, timed out, or its window
 * closed. The badge follows the "Thread needs interaction" alert preference;
 * with it off, the badge shows nothing.
 */
export class NeedsInputBadge {
  readonly #holds = new Map<symbol, string | symbol>()
  readonly #apply: (count: number) => void
  readonly #enabled: () => boolean
  #shown = 0

  constructor(apply: (count: number) => void, enabled: () => boolean) {
    this.#apply = apply
    this.#enabled = enabled
  }

  /** Count `threadId` as waiting until the returned release runs (idempotent). */
  hold(threadId: string | undefined): () => void {
    const token = Symbol('needs-input')
    this.#holds.set(token, threadId ?? token)
    this.refresh()
    return () => {
      if (this.#holds.delete(token)) this.refresh()
    }
  }

  /** Threads currently waiting, before the preference is applied. */
  pendingThreadCount(): number {
    return new Set(this.#holds.values()).size
  }

  /** Re-apply the badge, e.g. after the alert preference changes. */
  refresh(): void {
    const count = this.#enabled() ? this.pendingThreadCount() : 0
    if (count === this.#shown) return
    this.#shown = count
    this.#apply(count)
  }
}
