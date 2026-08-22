import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { lastExchange } from './last-exchange.ts'

/**
 * The composer's Tab-completable next step (experimental, off by default).
 *
 * When a turn ends, a small-tasks model call may name one obvious, high-value
 * next step. The input bar shows it as placeholder text and inserts it on Tab;
 * this controller owns the per-thread state — when to fetch, what the active
 * thread's hint is, and when a hint is spent — and stays DOM-free so the
 * input bar remains the only writer of the composer's attributes.
 */
export interface NextStepHintMount {
  /** The active thread's hint, or null when there is nothing to accept. */
  current(): string | null
  /** Spend the active thread's hint (accepted with Tab, or a message was sent). */
  clear(): void
  destroy(): void
}

interface CachedHint {
  turnKey: string
  /** null = this turn was asked (or spent) and offers nothing — never re-ask. */
  text: string | null
}

export function mountNextStepHint(
  store: AppStore,
  api: ApiClient,
  onChanged: () => void,
): NextStepHintMount {
  // Per-thread fetch tokens, for the same reason follow-up-suggestions has
  // them: idle completions interleave across threads, and a shared counter
  // would let thread B's completion drop thread A's in-flight hint.
  const fetchTokens = new Map<string, number>()
  const hintsByThread = new Map<string, CachedHint>()
  let displayed: string | null = null

  const nextFetchToken = (threadId: string): number => {
    const token = (fetchTokens.get(threadId) ?? 0) + 1
    fetchTokens.set(threadId, token)
    return token
  }

  function refreshDisplayed(): void {
    const activeId = store.getState().activeThreadId
    const exchange = activeId ? lastExchange(store, activeId) : null
    const cached = activeId ? hintsByThread.get(activeId) : undefined
    const next = exchange && cached && cached.turnKey === exchange.turnKey ? cached.text : null
    if (next === displayed) return
    displayed = next
    onChanged()
  }

  async function maybeFetchHint(threadId: string): Promise<void> {
    const exchange = lastExchange(store, threadId)
    if (!exchange) {
      hintsByThread.delete(threadId)
      refreshDisplayed()
      return
    }
    const cached = hintsByThread.get(threadId)
    if (cached?.turnKey === exchange.turnKey) {
      refreshDisplayed()
      return
    }
    // Experimental and off by default; checked per turn so flipping the toggle
    // needs no reload. Main gates too, so this only avoids a pointless IPC.
    if ((await api.settings.get('nextStepSuggestionEnabled')) !== true) {
      refreshDisplayed()
      return
    }

    const token = nextFetchToken(threadId)
    try {
      const text = await api.agent.suggestNextStep(JSON.stringify(exchange.context))
      if (token !== fetchTokens.get(threadId)) return
      hintsByThread.set(threadId, { turnKey: exchange.turnKey, text })
    } catch {
      if (token !== fetchTokens.get(threadId)) return
      // Record the failure against the turn: a hint is a bonus, not something
      // worth re-billing on every threads_changed until it succeeds.
      hintsByThread.set(threadId, { turnKey: exchange.turnKey, text: null })
    }
    refreshDisplayed()
  }

  const unsubs = [
    store.on('thread_status_changed', (tid, status) => {
      if (status === 'running') {
        hintsByThread.delete(tid)
        nextFetchToken(tid)
        refreshDisplayed()
        return
      }
      if (status === 'idle') void maybeFetchHint(tid)
    }),
    store.on('threads_changed', () => {
      // Covers switching to a thread whose finished turn was never asked (e.g.
      // restored on reload). Only an idle thread qualifies — a running one has
      // a half-streamed assistant message as its "last exchange".
      const activeId = store.getState().activeThreadId
      if (activeId && getThreadById(store, activeId)?.status === 'idle') {
        const exchange = lastExchange(store, activeId)
        if (exchange && hintsByThread.get(activeId)?.turnKey !== exchange.turnKey) {
          void maybeFetchHint(activeId)
          return
        }
      }
      refreshDisplayed()
    }),
  ]

  return {
    current: (): string | null => displayed,

    clear(): void {
      const activeId = store.getState().activeThreadId
      if (activeId) {
        const exchange = lastExchange(store, activeId)
        // Keep the turn marked as answered — the hint was consumed, and must
        // not come back on the next threads_changed.
        if (exchange) hintsByThread.set(activeId, { turnKey: exchange.turnKey, text: null })
        else hintsByThread.delete(activeId)
      }
      refreshDisplayed()
    },

    destroy(): void {
      // After clear(), get() returns undefined, so in-flight fetches bail on
      // the token comparison.
      fetchTokens.clear()
      unsubs.forEach((u) => {
        u()
      })
      hintsByThread.clear()
      displayed = null
    },
  }
}
