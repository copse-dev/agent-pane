import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getThreadById, setThreadTitle } from '@shared/store/thread-helpers.ts'
import type { Message } from '@shared/types'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'

// Threads with a suggestion in flight, so the two call sites (first text chunk,
// first tool call) of a turn don't both fire the same pass.
const inFlight = new Set<string>()

/**
 * User-message counts at which each successive naming pass fires. The first
 * message names the thread; the later thresholds re-title it once the thread has
 * grown enough that its opening line no longer describes it. One entry per pass,
 * so the array length is also the lifetime cap on model calls per thread.
 */
const PASS_THRESHOLDS = [1, 3, 8]

function firstWords(text: string, n = 6): string {
  return text.split(/\s+/).slice(0, n).join(' ').slice(0, 60) || 'New Thread'
}

/**
 * What the naming model sees: the opening message (the thread's original goal)
 * plus the most recent few, so a re-title reflects where the thread actually
 * went without losing what it set out to do.
 */
function namingInput(userMessages: Message[]): string {
  const first = userMessages[0]
  if (!first) return ''
  const recent = userMessages.slice(1).slice(-3)
  return [first, ...recent].map((m) => m.content.trim().slice(0, 300)).join('\n\n')
}

/**
 * Thread naming: kicks off when the agent first responds (visible text or a tool
 * call), so the title overlaps the rest of the turn instead of waiting for
 * `done`. Uses the configured small-tasks model, with a plain word-slice
 * fallback for the first pass.
 *
 * Runs again at the later {@link PASS_THRESHOLDS}, replacing a title we wrote
 * ourselves with one that accounts for where the thread has gone since. A title
 * the user typed is never touched: a manual rename clears `autoTitleCount`,
 * which retires the thread from naming for good.
 */
export function maybeNameThread(store: AppStore, api: ApiClient, threadId: string): void {
  if (inFlight.has(threadId)) return
  const thread = getThreadById(store, threadId)
  if (!thread) return
  const passes = thread.autoTitleCount ?? 0
  // A title we did not write is the user's, even if they wrote it before we got
  // to name the thread at all.
  if (passes === 0 && thread.title !== 'New Thread') return
  const threshold = PASS_THRESHOLDS[passes]
  if (threshold === undefined) return
  const userMessages = thread.messages.filter((m) => m.role === 'user' && m.content.trim())
  const first = userMessages[0]
  if (!first || userMessages.length < threshold) return
  const titleBefore = thread.title
  const input = namingInput(userMessages)
  inFlight.add(threadId)

  void (async (): Promise<void> => {
    let title: string | null
    try {
      title = await api.agent.suggestTitle(input)
    } catch {
      title = null
    } finally {
      inFlight.delete(threadId)
    }
    // Skip if the thread was renamed while the suggestion was in flight — by the
    // user, or by a pass that beat us to it.
    const current = getThreadById(store, threadId)
    if (!current) return
    if (current.title !== titleBefore || (current.autoTitleCount ?? 0) !== passes) return
    // A failed later pass keeps the title it already has rather than falling back
    // to a word slice, but still spends the pass so a dead model can't be
    // re-asked on every turn.
    const fallback = passes === 0 ? firstWords(first.content) : current.title
    setThreadTitle(store, threadId, nonEmptyStringOr(title?.trim(), fallback), {
      autoTitleCount: passes + 1,
    })
  })()
}
