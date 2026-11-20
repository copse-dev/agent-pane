/**
 * Resolve after `ms` milliseconds on a plain, referenced timer. Environment
 * neutral (main, renderer and packages), unlike `node:timers/promises`, which
 * the renderer cannot import. A caller that needs cancellation, an unref'd
 * timer or an injected clock should keep its own helper rather than grow this.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
