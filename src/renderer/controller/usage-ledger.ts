import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { UsageDelta } from '@shared/types'

function recordUsage(api: ApiClient, store: AppStore, threadId: string, delta: UsageDelta): void {
  if (!delta.inputTokens && !delta.outputTokens) return
  const { activeProjectId } = store.getState()
  void api.usage.record({
    model: delta.model,
    source: 'agent',
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    ...(delta.cacheReadTokens !== undefined ? { cacheReadTokens: delta.cacheReadTokens } : {}),
    ...(delta.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: delta.cacheCreationTokens }
      : {}),
    ...(activeProjectId ? { projectId: activeProjectId } : {}),
    threadId,
  })
}

/** Mirror agent usage deltas into the global usage ledger (day/month/90d windows). */
export function attachUsageLedger(store: AppStore, api: ApiClient): () => void {
  return store.on('usage_delta', (threadId, delta) => {
    recordUsage(api, store, threadId, delta)
  })
}

export function recordUsageDelta(
  api: ApiClient,
  store: AppStore,
  threadId: string,
  delta: UsageDelta,
): void {
  recordUsage(api, store, threadId, delta)
}
