/**
 * Who is still subscribed to each shared `fs:watch` watcher.
 *
 * One watcher serves a (project, thread, path) key for every app window, so a
 * window's `fs:unwatch` — or the window closing — may only stop it once no
 * other window still holds a subscription. Counts are per subscriber because a
 * window can watch the same file from more than one pane, and a closed window
 * never sends its unwatches.
 */
export class WatchSubscriptions {
  readonly #counts = new Map<string, Map<number, number>>()

  add(key: string, subscriberId: number): void {
    const bySubscriber = this.#counts.get(key) ?? new Map<number, number>()
    bySubscriber.set(subscriberId, (bySubscriber.get(subscriberId) ?? 0) + 1)
    this.#counts.set(key, bySubscriber)
  }

  /** Drop one subscription. True when the key has no subscribers left. */
  remove(key: string, subscriberId: number): boolean {
    const bySubscriber = this.#counts.get(key)
    if (!bySubscriber) return true
    const count = bySubscriber.get(subscriberId) ?? 0
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
  }
}
