import { AsyncLocalStorage } from 'node:async_hooks'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'

// Shared async identity only: sandbox configuration also runs in headless ACP workers.
// Keep activation policy and all desktop/native imports in thread-models.ts.
interface ActiveRunIdentity {
  readonly threadId: string
  model: string | null
  turnTreeId: TurnTreeId | null
}

export const activeRunStorage = new AsyncLocalStorage<ActiveRunIdentity>()

/** Scope the active thread/model identity to one complete asynchronous run. */
export function runWithActiveRunIdentity<T>(threadId: string, fn: () => T): T {
  return activeRunStorage.run({ threadId, model: null, turnTreeId: null }, fn)
}

/** Thread whose run is currently executing tools, or null when idle. */
export function getActiveRunThread(): string | null {
  return activeRunStorage.getStore()?.threadId ?? null
}
