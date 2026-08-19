/**
 * Renderer access to the performance tracer (DEBUG BRANCH, `COPSE_PERF=1`).
 *
 * The preload exposes `window.__copsePerf` only under the flag, so this is a
 * no-op in every normal launch and needs no flag check of its own beyond the
 * presence test. Kept dependency-free so it can be imported from anywhere in the
 * renderer without dragging the store or the API surface along.
 *
 * What the renderer contributes that no other layer can: the boundaries of a
 * user-visible action. Main sees `threads:loadProject` take N ms; only the
 * renderer knows that call sat inside "the user clicked a project and the pane
 * was unusable until it finished".
 */

type Detail = Record<string, string | number | boolean | undefined>

interface PerfBridge {
  enabled: boolean
  mark(name: string, detail?: Detail): void
  span(name: string, ms: number, detail?: Detail): void
}

/** The preload exposes the bridge only under the flag, so its absence is normal. */
function readBridge(): PerfBridge | null {
  const candidate: unknown = Reflect.get(globalThis, '__copsePerf')
  if (typeof candidate !== 'object' || candidate === null) return null
  const mark: unknown = Reflect.get(candidate, 'mark')
  const span: unknown = Reflect.get(candidate, 'span')
  if (typeof mark !== 'function' || typeof span !== 'function') return null
  return {
    enabled: true,
    mark: (name: string, detail?: Detail): void => {
      Reflect.apply(mark, candidate, [name, detail])
    },
    span: (name: string, ms: number, detail?: Detail): void => {
      Reflect.apply(span, candidate, [name, ms, detail])
    },
  }
}

const bridge = readBridge()

export const perfOn = bridge !== null

export function mark(name: string, detail?: Detail): void {
  bridge?.mark(name, detail)
}

/** Open a span; call the returned function when the work completes. */
export function begin(name: string): (detail?: Detail) => void {
  if (!bridge) return () => undefined
  const start = performance.now()
  return (detail?: Detail) => {
    bridge.span(name, Math.round((performance.now() - start) * 100) / 100, detail)
  }
}
