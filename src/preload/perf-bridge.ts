/**
 * Renderer-side half of the performance tracer (DEBUG BRANCH, `COPSE_PERF=1`).
 *
 * The preload is the only place that sees every renderer→main round trip, so it
 * is where renderer-observed latency is measured: the wall time from `invoke` to
 * resolution. That number includes main's handler time, any queueing behind
 * other work on main's single event loop, and the structured-clone cost of the
 * payload in both directions — all of which are invisible to main's own timing.
 * Comparing the two is how "the handler is slow" gets separated from "the reply
 * is enormous" and from "main was busy with something else".
 *
 * Records are forwarded to main (`perf:record`, fire-and-forget) so one NDJSON
 * file holds main, preload and renderer events on one axis. `COPSE_PERF_ORIGIN`
 * is the shared wall-clock anchor main published when it armed the tracer.
 */

import { contextBridge, ipcRenderer } from 'electron'

const ENABLED = process.env['COPSE_PERF'] === '1'
const ORIGIN = Number(process.env['COPSE_PERF_ORIGIN'] ?? Date.now())

type Detail = Record<string, string | number | boolean | undefined>

function since(): number {
  return Date.now() - ORIGIN
}

function send(record: {
  t: number
  kind: 'mark' | 'span'
  src: 'preload' | 'renderer'
  name: string
  ms?: number
  detail?: Detail
}): void {
  try {
    ipcRenderer.send('perf:record', record)
  } catch {
    // A tracer must never break the surface it is measuring.
  }
}

/**
 * Time every `ipcRenderer.invoke`. Patched in place rather than threaded through
 * the ~200 call sites in `preload/index.ts`, which is both smaller and — more to
 * the point — cannot miss one.
 */
export function installPreloadPerfTracing(): void {
  if (!ENABLED) return
  // `invoke` is typed as returning `Promise<any>`; pin it to `unknown` here so the
  // wrapper never launders an `any` into the rest of the preload.
  const original: (channel: string, ...args: unknown[]) => Promise<unknown> =
    ipcRenderer.invoke.bind(ipcRenderer)
  ipcRenderer.invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const start = performance.now()
    const t = since()
    try {
      const result: unknown = await original(channel, ...args)
      send({
        t,
        kind: 'span',
        src: 'preload',
        name: `invoke:${channel}`,
        ms: Math.round((performance.now() - start) * 100) / 100,
        // Payload size is the other half of the story for `threads:loadProject`:
        // a reply large enough to matter costs structured-clone time at both
        // ends and heap in the renderer. Measured only for array replies, where
        // the count is the meaningful figure and computing it is O(1).
        ...(Array.isArray(result) ? { detail: { rows: result.length } } : {}),
      })
      return result
    } catch (err) {
      send({
        t,
        kind: 'span',
        src: 'preload',
        name: `invoke:${channel}`,
        ms: Math.round((performance.now() - start) * 100) / 100,
        detail: { failed: true },
      })
      throw err
    }
  }
}

/**
 * `window.__copsePerf` — how renderer code marks its own phases (project switch
 * start/end, first paint). Exposed only under the flag.
 */
export function exposePerfBridge(): void {
  if (!ENABLED) return
  contextBridge.exposeInMainWorld('__copsePerf', {
    enabled: true,
    mark(name: string, detail?: Detail) {
      send({ t: since(), kind: 'mark', src: 'renderer', name, ...(detail ? { detail } : {}) })
    },
    span(name: string, ms: number, detail?: Detail) {
      send({ t: since(), kind: 'span', src: 'renderer', name, ms, ...(detail ? { detail } : {}) })
    },
  })
}
