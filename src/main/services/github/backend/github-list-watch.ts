/**
 * One PR-list poll cadence for the whole app.
 *
 * HTTP ETags, GraphQL in-flight coalesce, 429 backoff, and the method TTL cache
 * already live in the main process and are shared by every window. The renderer
 * used to arm its own `setInterval` per pane, so a main window and a PR pop-out
 * (or two test main windows) could stagger and double GitHub traffic whenever a
 * TTL expired. Watchers here are keyed by `webContents.id`; one timer runs
 * while any pane is showing PRs. `register-handlers` wires the tick to
 * `broadcastToAppWindows('gh:lists_tick')`.
 */

/** Same interval the PR pane used when it polled locally. */
export const GITHUB_LIST_WATCH_INTERVAL_MS = 30_000

export interface GitHubListWatchSnapshot {
  watcherCount: number
  includeMyPrs: boolean
  timerArmed: boolean
}

const watchers = new Map<number, { includeMyPrs: boolean }>()
let timer: ReturnType<typeof setInterval> | null = null
let broadcast: () => void = (): void => {
  // Wired by `setGitHubListWatchBroadcast` from register-handlers.
}

function syncTimer(): void {
  if (watchers.size === 0) {
    if (timer === null) return
    clearInterval(timer)
    timer = null
    return
  }
  if (timer !== null) return
  timer = setInterval(() => {
    notifyGitHubListWatchers()
  }, GITHUB_LIST_WATCH_INTERVAL_MS)
}

/**
 * Register or drop a renderer's interest in PR-list ticks.
 *
 * `includeMyPrs` is the union across watchers (a pane that has expanded
 * "your other PRs"). The tick itself is just a broadcast — each pane still
 * fetches only what it is showing, and the read cache coalesces overlap.
 */
export function setGitHubListWatch(
  watcherId: number,
  watching: boolean,
  includeMyPrs: boolean,
): void {
  if (!watching) watchers.delete(watcherId)
  else watchers.set(watcherId, { includeMyPrs })
  syncTimer()
}

/** Wake every watching pane so they re-read through the shared cache. */
export function notifyGitHubListWatchers(): void {
  if (watchers.size === 0) return
  broadcast()
}

/** Production wiring — fan ticks to every app window. */
export function setGitHubListWatchBroadcast(next: () => void): void {
  broadcast = next
}

/** @internal test helper */
export function gitHubListWatchSnapshotForTest(): GitHubListWatchSnapshot {
  let includeMyPrs = false
  for (const watcher of watchers.values()) {
    if (watcher.includeMyPrs) includeMyPrs = true
  }
  return {
    watcherCount: watchers.size,
    includeMyPrs,
    timerArmed: timer !== null,
  }
}

/** @internal test helper */
export function resetGitHubListWatchForTest(): void {
  watchers.clear()
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  broadcast = (): void => undefined
}
