/**
 * Periodically import Cursor cloud agents launched outside Copse into the open
 * project's thread list. Scoped to the renderer’s active project only.
 *
 * Deliberately does **not** sync on editor/app open — the first tick fires after
 * one full interval so startup stays quiet.
 */
import type { AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { loadThreads } from './persistence.ts'

/** How often to poll Cursor for outside agents for the open project. */
export const EXTERNAL_CURSOR_AGENT_SYNC_INTERVAL_MS = 5 * 60 * 1000

/**
 * Prefer in-memory threads (live runs / drafts) over freshly loaded disk copies,
 * and append any disk-only stubs (newly imported outside agents).
 */
export function mergeDiskThreadsPreferMemory(
  memory: readonly Thread[],
  disk: readonly Thread[],
): Thread[] {
  const memById = new Map(memory.map((thread) => [thread.id, thread]))
  const merged: Thread[] = []
  const seen = new Set<string>()
  for (const thread of disk) {
    merged.push(memById.get(thread.id) ?? thread)
    seen.add(thread.id)
  }
  for (const thread of memory) {
    if (!seen.has(thread.id)) merged.push(thread)
  }
  return sortThreadsNewestFirst(merged)
}

export interface ExternalCursorAgentSync {
  /** Run one sync immediately (tests / manual). No-op while a sync is in flight. */
  syncNow(): Promise<void>
  stop(): void
}

export interface StartExternalCursorAgentSyncOptions {
  intervalMs?: number
  /** Injected timers for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown
  clearIntervalFn?: (id: unknown) => void
  loadThreadsImpl?: typeof loadThreads
}

/**
 * Start the background sync. First automatic tick is after `intervalMs` — never
 * on start. Call from the main window only (not pop-outs).
 */
export function startExternalCursorAgentSync(
  store: AppStore,
  api: ApiClient,
  options: StartExternalCursorAgentSyncOptions = {},
): ExternalCursorAgentSync {
  const intervalMs = options.intervalMs ?? EXTERNAL_CURSOR_AGENT_SYNC_INTERVAL_MS
  const loadThreadsImpl = options.loadThreadsImpl ?? loadThreads

  let inflight: Promise<void> | null = null
  let syncGeneration = 0

  const runSync = async (): Promise<void> => {
    const projectId = store.getState().activeProjectId
    if (!projectId) return
    const gen = syncGeneration

    let importedCount: number
    try {
      const result = await api.remoteAgent.discoverExternal(projectId)
      importedCount = result.imported.length
    } catch (err) {
      // Missing Cursor key, non-GitHub project, network — stay quiet; next tick retries.
      console.debug('[external-cursor-agent-sync] discover skipped:', err)
      return
    }
    if (gen !== syncGeneration || importedCount === 0) return
    if (store.getState().activeProjectId !== projectId) return

    const disk = await loadThreadsImpl(api, projectId)
    if (gen !== syncGeneration || store.getState().activeProjectId !== projectId) return

    const merged = mergeDiskThreadsPreferMemory(store.getState().threads, disk)
    store.setState({ threads: merged })
    store.emit('threads_changed')
  }

  const syncNow = async (): Promise<void> => {
    if (inflight) return
    inflight = runSync().finally(() => {
      inflight = null
    })
    await inflight
  }

  const cancelTimer = ((): (() => void) => {
    if (options.setIntervalFn) {
      const id = options.setIntervalFn(() => {
        void syncNow()
      }, intervalMs)
      return (): void => {
        options.clearIntervalFn?.(id)
      }
    }
    const id = setInterval(() => {
      void syncNow()
    }, intervalMs)
    return (): void => {
      clearInterval(id)
    }
  })()

  return {
    syncNow,
    stop: (): void => {
      syncGeneration += 1
      cancelTimer()
    },
  }
}
