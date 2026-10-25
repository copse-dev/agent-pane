/**
 * Per-thread presentation state for transcript disclosures (tool cards,
 * rollups, groups, group members and reasoning trails).
 *
 * Execution status and presentation are deliberately separate: a disclosure's
 * openness comes from this model, never from the previous DOM. Each key is in
 * exactly one mode:
 *
 * - `auto`: the renderer's policy decides (see
 *   docs/plans/thread-layout-stability.md). Automatic reveals are tracked so
 *   run-end compaction closes only what the policy opened.
 * - `user-open` / `user-closed`: an explicit choice, which wins over every
 *   automatic decision for the mounted session, including thread switches.
 *
 * Timers for delayed reveal and run-end compaction live here too, so their
 * lifetime is tied to the model; the DOM side is reached only through the
 * host callbacks.
 */

export type DisclosureMode = 'auto' | 'user-open' | 'user-closed'

/**
 * How the policy treats a disclosure:
 * - `container`: a rollup or run step. Background activity stays quiet, even
 *   while it runs or a child fails; failures render beside it.
 * - `tool`: an individual card or group. Failures open; long-running work can
 *   reveal once after a delay.
 * - `entry`: one call inside a group. Only failures open it automatically.
 */
export type DisclosureKind = 'container' | 'tool' | 'entry'

export type DisclosureStatus = 'running' | 'done' | 'error' | 'interrupted'

export interface DisclosureUpdate {
  kind: DisclosureKind
  status: DisclosureStatus
  /** Whether this disclosure may reveal itself after the delay while running. */
  autoRevealEligible: boolean
}

export interface DisclosureTiming {
  /** Fast operations should finish without flashing their detail open. */
  revealDelayMs: number
  /** Once shown, live detail remains visible long enough to be read. */
  minDwellMs: number
  /** Compact auto-opened work once, after the completed run has gone quiet. */
  compactDelayMs: number
}

export interface DisclosureHost {
  /** Whether an automatic reveal may change geometry now (reader at the live end). */
  canReveal(): boolean
  /** Whether a thread's compaction may run now, or must wait for the reader. */
  canCompact(threadId: string): boolean
  /** Open the disclosure. Returns false when it is no longer on screen. */
  reveal(key: string): boolean
  /** Close an automatically opened disclosure. */
  collapse(key: string): void
  /** Called once a thread's compaction pass has closed its auto-opened work. */
  compacted(threadId: string): void
}

export interface DisclosureClock {
  now(): number
  /** Run `callback` after `ms`; returns a function that cancels it. */
  schedule(callback: () => void, ms: number): () => void
}

interface Entry {
  threadId: string
  mode: DisclosureMode
  /** When the policy opened it, or null when it is not auto-open. */
  autoOpenedAt: number | null
  running: boolean
  failed: boolean
}

export interface DisclosureModel {
  mode(key: string): DisclosureMode
  /** The explicit user choice, or undefined while the policy decides. */
  userChoice(key: string): boolean | undefined
  isAutoOpen(key: string): boolean
  /** Record an explicit open/close (click, keyboard or an equivalent action). */
  choose(threadId: string, key: string, open: boolean): void
  /**
   * Record the latest execution status for a disclosure and return whether it
   * should be open. May schedule a delayed reveal.
   */
  update(threadId: string, key: string, update: DisclosureUpdate): boolean
  hasAutoOpen(threadId: string): boolean
  /** A run finished: compact automatically opened work after the quiet period. */
  scheduleCompaction(threadId: string): void
  /** A run (re)started: pending compaction no longer applies. */
  cancelCompaction(threadId: string): void
  /** The reader returned to the live end: run compaction deferred for them. */
  resumeDeferredCompaction(threadId: string): void
  dispose(): void
}

const systemClock: DisclosureClock = {
  now: () => Date.now(),
  schedule(callback, ms): () => void {
    const timer = setTimeout(callback, ms)
    return () => {
      clearTimeout(timer)
    }
  },
}

export function createDisclosureModel(
  host: DisclosureHost,
  timing: DisclosureTiming,
  clock: DisclosureClock = systemClock,
): DisclosureModel {
  const entries = new Map<string, Entry>()
  const revealTimers = new Map<string, () => void>()
  const compactTimers = new Map<string, () => void>()
  const deferredCompactions = new Set<string>()

  function entryFor(threadId: string, key: string): Entry {
    let entry = entries.get(key)
    if (!entry) {
      entry = { threadId, mode: 'auto', autoOpenedAt: null, running: false, failed: false }
      entries.set(key, entry)
    }
    return entry
  }

  function cancelReveal(key: string): void {
    revealTimers.get(key)?.()
    revealTimers.delete(key)
  }

  function markAutoOpen(entry: Entry): void {
    entry.autoOpenedAt ??= clock.now()
  }

  function scheduleReveal(key: string, entry: Entry): void {
    if (revealTimers.has(key) || entry.autoOpenedAt !== null) return
    const timer = clock.schedule(() => {
      revealTimers.delete(key)
      if (!entry.running || entry.mode !== 'auto' || !host.canReveal()) return
      if (!host.reveal(key)) return
      markAutoOpen(entry)
    }, timing.revealDelayMs)
    revealTimers.set(key, timer)
  }

  function cancelCompaction(threadId: string): void {
    compactTimers.get(threadId)?.()
    compactTimers.delete(threadId)
  }

  function compact(threadId: string): void {
    compactTimers.delete(threadId)
    if (!host.canCompact(threadId)) {
      deferredCompactions.add(threadId)
      return
    }
    deferredCompactions.delete(threadId)
    // Failed work keeps its diagnostics visible; successful-work compaction
    // must not hide an error.
    const compactable = [...entries].filter(
      ([, entry]) => entry.threadId === threadId && entry.autoOpenedAt !== null && !entry.failed,
    )
    const now = clock.now()
    let dwellRemaining = 0
    for (const [, entry] of compactable) {
      const shownFor = now - (entry.autoOpenedAt ?? now)
      dwellRemaining = Math.max(dwellRemaining, timing.minDwellMs - shownFor)
    }
    if (dwellRemaining > 0) {
      compactTimers.set(
        threadId,
        clock.schedule(() => {
          compact(threadId)
        }, Math.ceil(dwellRemaining)),
      )
      return
    }
    for (const [key, entry] of compactable) {
      entry.autoOpenedAt = null
      if (entry.mode === 'auto') host.collapse(key)
    }
    host.compacted(threadId)
  }

  function scheduleCompaction(threadId: string): void {
    cancelCompaction(threadId)
    compactTimers.set(
      threadId,
      clock.schedule(() => {
        compact(threadId)
      }, timing.compactDelayMs),
    )
  }

  return {
    mode: (key) => entries.get(key)?.mode ?? 'auto',
    userChoice(key): boolean | undefined {
      const mode = entries.get(key)?.mode
      return mode === 'user-open' ? true : mode === 'user-closed' ? false : undefined
    },
    isAutoOpen: (key) => (entries.get(key)?.autoOpenedAt ?? null) !== null,
    choose(threadId, key, open): void {
      const entry = entryFor(threadId, key)
      entry.mode = open ? 'user-open' : 'user-closed'
      entry.autoOpenedAt = null
      cancelReveal(key)
    },
    update(threadId, key, { kind, status, autoRevealEligible }): boolean {
      const entry = entryFor(threadId, key)
      entry.failed = status === 'error'
      if (status === 'interrupted') entry.autoOpenedAt = null
      if (kind !== 'entry') {
        entry.running = status === 'running'
        if (!entry.running) cancelReveal(key)
      }

      if (entry.mode !== 'auto') return entry.mode === 'user-open'
      if (kind === 'container') return false
      if (entry.failed) {
        // Failed tools stay expanded so the error is visible without a click,
        // including those that never ran long enough to reveal.
        markAutoOpen(entry)
        return true
      }
      if (kind === 'entry') return false
      if (entry.autoOpenedAt !== null) return true
      if (entry.running && autoRevealEligible) scheduleReveal(key, entry)
      return false
    },
    hasAutoOpen(threadId): boolean {
      for (const entry of entries.values()) {
        if (entry.threadId === threadId && entry.autoOpenedAt !== null) return true
      }
      return false
    },
    scheduleCompaction,
    cancelCompaction,
    resumeDeferredCompaction(threadId): void {
      if (deferredCompactions.delete(threadId)) scheduleCompaction(threadId)
    },
    dispose(): void {
      for (const cancel of revealTimers.values()) cancel()
      for (const cancel of compactTimers.values()) cancel()
      revealTimers.clear()
      compactTimers.clear()
      deferredCompactions.clear()
    },
  }
}
