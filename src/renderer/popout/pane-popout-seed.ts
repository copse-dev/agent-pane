import type { RightPanelMode } from '@shared/types/state.ts'

export interface PopoutSeedHandlers {
  capture: () => unknown
  apply: (seed: unknown) => void | Promise<void>
}

const handlers = new Map<RightPanelMode, PopoutSeedHandlers>()

export function registerPopoutSeedHandlers(
  mode: RightPanelMode,
  next: PopoutSeedHandlers,
): () => void {
  handlers.set(mode, next)
  return () => {
    if (handlers.get(mode) === next) handlers.delete(mode)
  }
}

export function capturePopoutSeed(mode: RightPanelMode): unknown {
  return handlers.get(mode)?.capture() ?? null
}

export async function applyPopoutSeed(mode: RightPanelMode, seed: unknown): Promise<void> {
  if (seed == null) return
  await handlers.get(mode)?.apply(seed)
}
