// When the chat default setting is `auto:best-value`, each new blank thread
// resolves to a concrete routable model (plan/price Pareto winner) so the
// footer picker shows the provider that will actually run.

import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  getActiveThread,
  isBlankThread,
  hasUnsubmittedPrompt,
} from '@shared/store/thread-helpers.ts'
import { isBestValueChatModel } from '@shared/lm-studio-defaults.ts'

/**
 * If the active blank thread still carries the best-value sentinel (or inherits
 * it from settings), replace it with the concrete best-value model. No-op when
 * the thread already has a concrete model or is no longer blank.
 */
export async function resolveBestValueForActiveBlankThread(
  store: AppStore,
  api: ApiClient,
): Promise<void> {
  const thread = getActiveThread(store)
  if (!thread || !isBlankThread(thread) || hasUnsubmittedPrompt(thread)) return

  const settingsModel = store.getState().settings?.model
  const current = thread.model ?? settingsModel
  if (!isBestValueChatModel(current)) return

  let resolved: string
  try {
    resolved = await api.models.bestValueDefault()
  } catch {
    return
  }
  if (!resolved || isBestValueChatModel(resolved)) return

  // Re-check: user may have switched threads or typed a draft while we waited.
  const latest = getActiveThread(store)
  if (!latest || latest.id !== thread.id) return
  if (!isBlankThread(latest) || hasUnsubmittedPrompt(latest)) return
  const latestModel = latest.model ?? store.getState().settings?.model
  if (!isBestValueChatModel(latestModel)) return

  store.setState({
    threads: store
      .getState()
      .threads.map((t) => (t.id === thread.id ? { ...t, model: resolved } : t)),
  })
  store.emit('threads_changed')
}

/** Subscribe once: every new chat window re-picks the best-value model. */
export function attachBestValueDefaultResolver(store: AppStore, api: ApiClient): () => void {
  return store.on('new_thread_opened', () => {
    void resolveBestValueForActiveBlankThread(store, api)
  })
}
