// When the chat default setting is a dynamic selector (`auto:best-value`,
// `auto:balanced`, …), each new blank thread resolves it to a concrete routable
// model so the footer picker shows the provider that will actually run.

import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  getActiveThread,
  isBlankThread,
  hasUnsubmittedPrompt,
} from '@shared/store/thread-helpers.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'

/** The only `ApiClient` slice this module calls. */
type BestValueApi = { models: Pick<ApiClient['models'], 'bestValueDefault' | 'resolveDynamic'> }

/**
 * If the active blank thread still carries the best-value sentinel (or inherits
 * it from settings), replace it with the concrete best-value model. No-op when
 * the thread already has a concrete model or is no longer blank.
 */
export async function resolveBestValueForActiveBlankThread(
  store: AppStore,
  api: BestValueApi,
): Promise<void> {
  const thread = getActiveThread(store)
  if (!thread || !isBlankThread(thread) || hasUnsubmittedPrompt(thread)) return

  const settingsModel = store.getState().settings?.model
  const current = thread.model ?? settingsModel
  // Expand any dynamic selector (auto:best-value, auto:balanced, …) so a new
  // blank thread pinned by rule resolves to a concrete routable model. A pinned
  // id is already concrete and is left alone.
  if (typeof current !== 'string' || !isDynamicModel(current)) return

  let resolved: string
  try {
    resolved = await api.models.resolveDynamic(current)
  } catch {
    return
  }
  if (!resolved || isDynamicModel(resolved)) return

  // Re-check: user may have switched threads or typed a draft while we waited.
  const latest = getActiveThread(store)
  if (!latest || latest.id !== thread.id) return
  if (!isBlankThread(latest) || hasUnsubmittedPrompt(latest)) return
  const latestModel = latest.model ?? store.getState().settings?.model
  if (typeof latestModel !== 'string' || !isDynamicModel(latestModel)) return

  store.setState({
    threads: store
      .getState()
      .threads.map((t) => (t.id === thread.id ? { ...t, model: resolved } : t)),
  })
  store.emit('threads_changed')
}

/**
 * Subscribe once: every new chat window re-picks the best-value model. Project
 * restore also gets a pass because a persisted blank thread can become active
 * without emitting `new_thread_opened` during app startup.
 */
export function attachBestValueDefaultResolver(store: AppStore, api: BestValueApi): () => void {
  const resolve = (): void => {
    void resolveBestValueForActiveBlankThread(store, api)
  }
  const unsubscribeNewThread = store.on('new_thread_opened', resolve)
  const unsubscribeWorkspace = store.on('workspace_changed', resolve)
  return () => {
    unsubscribeNewThread()
    unsubscribeWorkspace()
  }
}
