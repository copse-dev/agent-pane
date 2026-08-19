/**
 * Generic IPC timing (DEBUG BRANCH, `COPSE_PERF=1` only).
 *
 * Copse registers roughly two hundred `ipcMain.handle` channels across a dozen
 * modules. Instrumenting them individually would be both enormous and
 * self-defeating — the interesting channel is whichever one turns out to be slow,
 * which is the thing we do not know yet. So this patches `ipcMain.handle` once,
 * before any registration runs, and wraps every listener.
 *
 * Two numbers per call matter and they are different:
 *   - main-process *service* time (this module): how long the handler ran.
 *   - renderer-observed *wait* (the preload bridge): service time plus queueing
 *     behind other work on main's single event loop plus structured-clone of the
 *     payload. When those diverge, the cost is contention or payload size, not
 *     the handler itself — which is exactly the distinction needed here.
 *
 * Channel names are static string literals from our own source, so recording
 * them leaks nothing about the user's data. Arguments are never recorded.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { perfCount, perfEnabled, perfMark, perfRecord, type PerfRecord } from './perf-trace.ts'

/**
 * The listener shape `ipcMain.handle` accepts. `unknown[]` rather than Electron's
 * `any[]`: the wrapper only forwards the arguments, so it never needs to know
 * their types, and keeping them opaque stops an `any` leaking out of here.
 */
type InvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** Channels invoked constantly by polling UI; counted but not spanned per call. */
const HIGH_FREQUENCY = new Set(['settings:get', 'storage:get', 'index:query'])

/** A handler slower than this gets its own span rather than only a counter. */
const SPAN_THRESHOLD_MS = 1

let patched = false

/**
 * Wrap `ipcMain.handle` so every channel is timed. Must run before
 * `registerAllHandlers` and the various `init*(win)` calls.
 */
export function installIpcPerfTracing(): void {
  if (!perfEnabled() || patched) return
  patched = true
  const original = ipcMain.handle.bind(ipcMain)
  // Same signature in and out — the wrapper only adds timing around the caller's
  // listener, so no assertion is needed to put it back on `ipcMain`.
  const patch = (channel: string, listener: InvokeListener): void => {
    const timed: InvokeListener = async (event, ...args) => {
      const start = process.hrtime.bigint()
      try {
        return await listener(event, ...args)
      } finally {
        const ms = Number(process.hrtime.bigint() - start) / 1e6
        perfCount(`ipc:${channel}`, ms)
        if (ms >= SPAN_THRESHOLD_MS && !HIGH_FREQUENCY.has(channel)) {
          perfMark(`ipc:${channel}`, { ms: Math.round(ms * 100) / 100 })
        }
      }
    }
    // Electron declares the listener's rest parameter as `any[]`; `unknown[]` is
    // the stricter shape, and a function accepting less is safe to install where
    // one accepting more is expected.
    original(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => timed(event, ...args))
  }
  ipcMain.handle = patch
}

/**
 * Receive trace records produced in the preload/renderer and fold them into the
 * single main-process NDJSON stream, so one file holds the whole ordered story.
 */
export function installRendererPerfChannel(): void {
  if (!perfEnabled()) return
  ipcMain.on('perf:record', (_event, raw: unknown) => {
    const record = decodePerfRecord(raw)
    if (record !== null) perfRecord(record)
  })
}

/**
 * Narrow an IPC payload to a trace record. Renderer-supplied data crosses a
 * process boundary, so it is decoded field by field rather than asserted — the
 * same discipline every other channel uses, and the reason this returns `null`
 * instead of throwing: a malformed diagnostic must never surface as an error in
 * the app being diagnosed.
 */
function decodePerfRecord(raw: unknown): PerfRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const fields: Record<string, unknown> = { ...raw }
  const { t, name, kind, src, ms, detail } = fields
  if (typeof name !== 'string' || typeof t !== 'number') return null
  return {
    t,
    kind: kind === 'span' ? 'span' : 'mark',
    src: src === 'preload' ? 'preload' : 'renderer',
    name,
    ...(typeof ms === 'number' ? { ms } : {}),
    ...(isDetail(detail) ? { detail } : {}),
  }
}

function isDetail(value: unknown): value is NonNullable<PerfRecord['detail']> {
  return typeof value === 'object' && value !== null
}
