import type { PopoutMode } from '../windows/create-popout-window.ts'

/** Ephemeral pane snapshot captured in the main window before a pop-out opens. */
const seeds = new Map<PopoutMode, unknown>()

export function stashPopoutSeed(mode: PopoutMode, seed: unknown): void {
  if (seed === undefined) {
    seeds.delete(mode)
    return
  }
  seeds.set(mode, seed)
}

/** Consumed once when the pop-out renderer applies the snapshot for `mode`. */
export function takePopoutSeed(mode: PopoutMode): unknown {
  const seed = seeds.get(mode)
  seeds.delete(mode)
  return seed ?? null
}

export function clearPopoutSeeds(): void {
  seeds.clear()
}
