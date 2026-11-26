/**
 * Who is still subscribed to each shared `fs:watch` watcher.
 *
 * One watcher serves a (project, thread, path) key for every app window, so a
 * window's `fs:unwatch` — or the window closing — may only stop it once no
 * other window still holds a subscription. Counts are per subscriber because a
 * window can watch the same file from more than one pane, and a closed window
 * never sends its unwatches.
 *
 * A watch resolves its path before it subscribes, and the renderer does not
 * wait for that before unwatching (opening a file and moving straight on to
 * the next). `begin`/`commit` cover the gap: an unwatch that arrives while its
 * watch is still resolving cancels that watch instead of being lost.
 */
export class WatchSubscriptions {
  readonly #counts = new Map<string, Map<number, number>>()
  readonly #pending = new Map<string, Map<number, PendingWatch[]>>()

  /** Note a watch that is still resolving. Settle it with `commit` or `discard`. */
  begin(key: string, subscriberId: number): PendingWatch {
    const pending: PendingWatch = { key, subscriberId, cancelled: false }
    const bySubscriber = this.#pending.get(key) ?? new Map<number, PendingWatch[]>()
    bySubscriber.set(subscriberId, [...(bySubscriber.get(subscriberId) ?? []), pending])
    this.#pending.set(key, bySubscriber)
    return pending
  }

  /** Subscribe a resolved watch. False when its unwatch already arrived: do not watch. */
  commit(pending: PendingWatch): boolean {
    this.discard(pending)
    if (pending.cancelled) return false
    this.add(pending.key, pending.subscriberId)
    return true
  }

  /** Forget a watch that will not subscribe (it failed, or its window closed). */
  discard(pending: PendingWatch): void {
    const bySubscriber = this.#pending.get(pending.key)
    const list = bySubscriber?.get(pending.subscriberId)
    if (!bySubscriber || !list) return
    const rest = list.filter((entry) => entry !== pending)
    if (rest.length > 0) bySubscriber.set(pending.subscriberId, rest)
    else bySubscriber.delete(pending.subscriberId)
    if (bySubscriber.size === 0) this.#pending.delete(pending.key)
  }

  add(key: string, subscriberId: number): void {
    const bySubscriber = this.#counts.get(key) ?? new Map<number, number>()
    bySubscriber.set(subscriberId, (bySubscriber.get(subscriberId) ?? 0) + 1)
    this.#counts.set(key, bySubscriber)
  }

  /** Drop one subscription. True when the key has no subscribers left. */
  remove(key: string, subscriberId: number): boolean {
    const bySubscriber = this.#counts.get(key)
    const count = bySubscriber?.get(subscriberId) ?? 0
    if (count === 0) {
      // Nothing subscribed yet: this unwatch answers a watch still resolving.
      const unresolved = this.#pending
        .get(key)
        ?.get(subscriberId)
        ?.find((entry) => !entry.cancelled)
      if (unresolved) unresolved.cancelled = true
    }
    if (!bySubscriber) return true
    if (count > 1) bySubscriber.set(subscriberId, count - 1)
    else bySubscriber.delete(subscriberId)
    if (bySubscriber.size > 0) return false
    this.#counts.delete(key)
    return true
  }

  /** Drop everything one subscriber holds. Returns the keys left with no subscribers. */
  removeSubscriber(subscriberId: number): string[] {
    const released: string[] = []
    for (const [key, bySubscriber] of this.#counts) {
      if (!bySubscriber.delete(subscriberId)) continue
      if (bySubscriber.size > 0) continue
      this.#counts.delete(key)
      released.push(key)
    }
    return released
  }

  clear(): void {
    this.#counts.clear()
    // A watch still resolving must not subscribe after everything was released.
    for (const bySubscriber of this.#pending.values()) {
      for (const list of bySubscriber.values()) {
        for (const pending of list) pending.cancelled = true
      }
    }
    this.#pending.clear()
  }
}

/** One `fs:watch` between its arrival and its subscription. */
export interface PendingWatch {
  readonly key: string
  readonly subscriberId: number
  cancelled: boolean
}
