/**
 * Recover a blank window when Chromium kills the renderer.
 *
 * The video decoder already treats `render-process-gone` as a tool error. The
 * main and pop-out windows had no handler, so an OOM or renderer crash left a
 * frozen chrome until the user quit. Reload once or twice; a crash loop must
 * not spin forever.
 */

export type RendererGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'

export interface RendererGoneDetails {
  reason: RendererGoneReason
  exitCode: number
}

export interface RendererReloadState {
  lastReloadAt: number
  recentCrashes: number
}

/** Crashes inside this window count toward the reload cap. */
export const RENDERER_RELOAD_WINDOW_MS = 15_000
/** Allow this many recoveries in the window; the next crash stays dead. */
export const RENDERER_RELOAD_MAX = 2

export function initialRendererReloadState(): RendererReloadState {
  return { lastReloadAt: 0, recentCrashes: 0 }
}

/**
 * Decide whether to reload after a renderer death. `clean-exit` is a normal
 * window close and must not reload.
 */
export function planRendererCrashRecovery(
  details: RendererGoneDetails,
  state: RendererReloadState,
  now: number,
): { reload: boolean; next: RendererReloadState } {
  if (details.reason === 'clean-exit') {
    return { reload: false, next: state }
  }
  const recentCrashes =
    state.lastReloadAt > 0 && now - state.lastReloadAt < RENDERER_RELOAD_WINDOW_MS
      ? state.recentCrashes + 1
      : 1
  const next: RendererReloadState = { lastReloadAt: now, recentCrashes }
  return { reload: recentCrashes <= RENDERER_RELOAD_MAX, next }
}

export interface RendererCrashTarget {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: RendererGoneDetails) => void,
  ): void
  isDestroyed(): boolean
  reload(): void
}

export function attachRendererCrashRecovery(
  contents: RendererCrashTarget,
  options: { log?: (message: string) => void; now?: () => number } = {},
): void {
  const log =
    options.log ??
    ((message: string) => {
      console.error(message)
    })
  const now = options.now ?? Date.now
  let state = initialRendererReloadState()
  contents.on('render-process-gone', (_event, details) => {
    const decision = planRendererCrashRecovery(details, state, now())
    state = decision.next
    log(
      `[renderer] process gone reason=${details.reason} exitCode=${String(details.exitCode)}` +
        (decision.reload ? ' — reloading' : ''),
    )
    if (!decision.reload || contents.isDestroyed()) return
    contents.reload()
  })
}
