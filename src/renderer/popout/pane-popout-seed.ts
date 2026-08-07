import type { AppStore } from '@shared/store/store.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { switchThread } from '@shared/store/thread-helpers.ts'

export interface PopoutSeedHandlers {
  capture: () => unknown
  apply: (seed: unknown) => void | Promise<void>
}

interface PopoutSeedEnvelope {
  projectId: string
  threadId: string
  paneSeed: unknown
}

const handlers = new Map<RightPanelMode, PopoutSeedHandlers>()
const pendingSeeds = new Map<RightPanelMode, unknown>()

function isPopoutSeedEnvelope(seed: unknown): seed is PopoutSeedEnvelope {
  return (
    seed !== null &&
    typeof seed === 'object' &&
    'projectId' in seed &&
    typeof seed.projectId === 'string' &&
    'threadId' in seed &&
    typeof seed.threadId === 'string' &&
    'paneSeed' in seed
  )
}

export function registerPopoutSeedHandlers(
  mode: RightPanelMode,
  next: PopoutSeedHandlers,
): () => void {
  handlers.set(mode, next)
  if (pendingSeeds.has(mode)) {
    const seed = pendingSeeds.get(mode)
    pendingSeeds.delete(mode)
    void next.apply(seed)
  }
  return () => {
    if (handlers.get(mode) === next) handlers.delete(mode)
  }
}

export function capturePopoutSeed(mode: RightPanelMode, store: AppStore): unknown {
  const paneSeed = handlers.get(mode)?.capture() ?? null
  const { activeProjectId, activeThreadId } = store.getState()
  if (!activeProjectId || !activeThreadId) return paneSeed
  return {
    projectId: activeProjectId,
    threadId: activeThreadId,
    paneSeed,
  } satisfies PopoutSeedEnvelope
}

export async function applyPopoutSeed(
  mode: RightPanelMode,
  seed: unknown,
  store: AppStore,
): Promise<void> {
  if (seed == null) return

  let paneSeed: unknown = seed
  if (isPopoutSeedEnvelope(seed)) {
    const state = store.getState()
    if (
      state.activeProjectId === seed.projectId &&
      state.activeThreadId !== seed.threadId &&
      state.threads.some((thread) => thread.id === seed.threadId)
    ) {
      switchThread(store, seed.threadId)
    }
    paneSeed = seed.paneSeed
  }

  const handler = handlers.get(mode)
  if (!handler) {
    pendingSeeds.set(mode, paneSeed)
    return
  }
  await handler.apply(paneSeed)
}
