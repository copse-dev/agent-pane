/**
 * Recover a blank window when Chromium kills the renderer.
 *
 * The video decoder already treats `render-process-gone` as a tool error. The
 * main and pop-out windows had no handler, so an OOM or renderer crash left a
 * frozen chrome until the user quit. Reload once or twice; a crash loop must
 * not spin forever, whether its crashes arrive seconds or minutes apart.
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
  /** When each recent crash happened, oldest first, within the loop window. */
  crashes: number[]
}

/** Crashes inside this window count toward the reload cap. */
export const RENDERER_RELOAD_WINDOW_MS = 15_000
/** Allow this many recoveries in the window; the next crash stays dead. */
export const RENDERER_RELOAD_MAX = 2
/**
 * A crash loop can also be slow: #4445 saw the same abort every 40 seconds,
 * which the 15-second cap never caught, so the window reloaded indefinitely.
 * Allow this many recoveries in the longer window, then stop.
 */
export const RENDERER_CRASH_LOOP_WINDOW_MS = 10 * 60_000
export const RENDERER_CRASH_LOOP_MAX = 3

export function initialRendererReloadState(): RendererReloadState {
  return { crashes: [] }
}

/**
 * Decide whether to reload after a renderer death. `clean-exit` is a normal
 * window close and must not reload. `loop` is true when the crash is refused
 * because crashes keep repeating, which is when the user must be told;
 * `stoppedBy` then names the cap that refused it, for the log line.
 */
export function planRendererCrashRecovery(
  details: RendererGoneDetails,
  state: RendererReloadState,
  now: number,
): {
  reload: boolean
  loop: boolean
  stoppedBy: { crashes: number; windowMs: number } | null
  next: RendererReloadState
} {
  if (details.reason === 'clean-exit') {
    return { reload: false, loop: false, stoppedBy: null, next: state }
  }
  const crashes = [...state.crashes.filter((at) => now - at < RENDERER_CRASH_LOOP_WINDOW_MS), now]
  const burst = crashes.filter((at) => now - at < RENDERER_RELOAD_WINDOW_MS).length
  const stoppedBy =
    burst > RENDERER_RELOAD_MAX
      ? { crashes: burst, windowMs: RENDERER_RELOAD_WINDOW_MS }
      : crashes.length > RENDERER_CRASH_LOOP_MAX
        ? { crashes: crashes.length, windowMs: RENDERER_CRASH_LOOP_WINDOW_MS }
        : null
  return { reload: stoppedBy === null, loop: stoppedBy !== null, stoppedBy, next: { crashes } }
}

function describeWindow(ms: number): string {
  return ms >= 60_000 ? `${String(ms / 60_000)} minutes` : `${String(ms / 1000)} seconds`
}

export interface RendererCrashTarget {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: RendererGoneDetails) => void,
  ): void
  isDestroyed(): boolean
  reload(): void
}

export interface RendererCrashRecoveryOptions {
  log?: (message: string) => void
  now?: () => number
  /**
   * What the window was doing when it died, for the log line. The exit code
   * alone does not say which call an out-of-memory abort was serializing.
   */
  context?: () => string | null
  /** Called for every death except a clean exit, after the decision is made. */
  record?: (record: {
    at: number
    reason: RendererGoneReason
    exitCode: number
    context: string | null
    action: 'reloaded' | 'stopped' | 'none'
  }) => void
  /**
   * Called once when recovery stops because the crash keeps repeating. The
   * window is left down; `retry` clears the crash history and reloads it, for a
   * user who chooses to try again. "Once" holds because a renderer that stays
   * down emits no further `render-process-gone` events until `retry` reloads
   * it; a second trigger for this callback would break that.
   */
  onCrashLoop?: (retry: () => void) => void
}

export function attachRendererCrashRecovery(
  contents: RendererCrashTarget,
  options: RendererCrashRecoveryOptions = {},
): void {
  const log =
    options.log ??
    ((message: string): void => {
      console.error(message)
    })
  const now = options.now ?? Date.now
  let state = initialRendererReloadState()
  contents.on('render-process-gone', (_event, details) => {
    const at = now()
    const decision = planRendererCrashRecovery(details, state, at)
    state = decision.next
    const crashed = details.reason !== 'clean-exit'
    const context = crashed ? (options.context?.() ?? null) : null
    log(
      `[renderer] process gone reason=${details.reason} exitCode=${String(details.exitCode)}` +
        (context ? ` ${context}` : '') +
        (decision.reload
          ? ' — reloading'
          : decision.stoppedBy
            ? ` — not reloading: ${String(decision.stoppedBy.crashes)} crashes in ${describeWindow(decision.stoppedBy.windowMs)}`
            : ''),
    )
    const destroyed = contents.isDestroyed()
    if (crashed) {
      try {
        options.record?.({
          at,
          reason: details.reason,
          exitCode: details.exitCode,
          context,
          action: destroyed ? 'none' : decision.reload ? 'reloaded' : 'stopped',
        })
      } catch {
        // A diagnostic must never stop the recovery it describes.
      }
    }
    if (destroyed) return
    if (decision.reload) {
      contents.reload()
      return
    }
    if (decision.loop) {
      options.onCrashLoop?.(() => {
        state = initialRendererReloadState()
        if (!contents.isDestroyed()) contents.reload()
      })
    }
  })
}
