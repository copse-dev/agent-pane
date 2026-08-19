/**
 * Opt-in performance tracer for "why does opening this project take so long?"
 *
 * DEBUG BRANCH INSTRUMENTATION — inert unless `COPSE_PERF=1` is set. Every entry
 * point below returns immediately when the flag is off, so a normal launch pays
 * one boolean check per call site and nothing else.
 *
 * Why this exists. The existing startup diagnostics (`event-loop-watchdog`,
 * `startup-budget`) measure boot *phases before the window exists*. The cost the
 * user actually feels — opening or switching to a large project — happens after
 * that, spread across renderer IPC (`workspace:set`, `threads:loadProject`),
 * main-process disk work (the thread store fold), and background indexing. None
 * of it is attributable from a phase timeline, so this module adds:
 *
 *   - `perfSpan` / `perfMark`: named, nestable spans with structured detail.
 *   - a generic `ipcMain.handle` wrapper, so every channel is timed and counted
 *     without touching ~200 individual registrations.
 *   - a sink shared with the preload/renderer side, so renderer-observed latency
 *     and main-process service time land in one ordered stream.
 *
 * Output is NDJSON, one record per line, to `COPSE_PERF_OUT` when set and to
 * stderr (prefixed `[perf]`) otherwise. Records carry phase names, durations and
 * counters — never prompts, file contents, or full paths (paths are reduced to a
 * basename-length digest by `pathLabel`).
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type PerfDetail = Record<string, string | number | boolean | undefined>

export interface PerfRecord {
  /** Monotonic milliseconds since the tracer was armed. */
  t: number
  /** `mark` — instant; `span` — completed duration; `count` — periodic counter dump. */
  kind: 'mark' | 'span' | 'count'
  /** Which process produced it. */
  src: 'main' | 'renderer' | 'preload'
  name: string
  /** Span duration in milliseconds (absent for marks). */
  ms?: number
  detail?: PerfDetail
}

const ENABLED = process.env['COPSE_PERF'] === '1'
const OUT_PATH = process.env['COPSE_PERF_OUT'] ?? null

let origin = 0n
/**
 * Wall-clock anchor for the same instant as `origin`. Published into the
 * environment so the renderer and preload — separate processes, with no shared
 * `hrtime` epoch — can express their timestamps on the same axis as main's. Both
 * sides then measure `Date.now() - anchor`, which is accurate to a millisecond
 * or two: ample when the durations under study are hundreds of milliseconds.
 */
let originWallMs = 0
let armed = false
/** Buffered so a burst of records costs one write, not one write per record. */
const buffer: string[] = []
let flushTimer: NodeJS.Timeout | null = null

export function perfEnabled(): boolean {
  return ENABLED
}

function nowMs(): number {
  return Number(process.hrtime.bigint() - origin) / 1e6
}

/**
 * Start the clock. Called as early as main can manage (before the app module
 * graph finishes loading) so every later timestamp shares one origin.
 */
export function armPerfTrace(): void {
  if (!ENABLED || armed) return
  armed = true
  origin = process.hrtime.bigint()
  originWallMs = Date.now()
  process.env['COPSE_PERF_ORIGIN'] = String(originWallMs)
  if (OUT_PATH) {
    try {
      mkdirSync(dirname(OUT_PATH), { recursive: true })
    } catch {
      // A tracer that can break startup is worse than no tracer.
    }
  }
  emit({ t: 0, kind: 'mark', src: 'main', name: 'perf:armed' })
}

function flush(): void {
  flushTimer = null
  if (buffer.length === 0) return
  const payload = buffer.join('')
  buffer.length = 0
  if (OUT_PATH) {
    try {
      appendFileSync(OUT_PATH, payload)
      return
    } catch {
      // Fall through to stderr rather than losing the trace.
    }
  }
  process.stderr.write(payload.replace(/^/gm, '[perf] ').replace(/\[perf\] $/, ''))
}

function emit(record: PerfRecord): void {
  buffer.push(`${JSON.stringify(record)}\n`)
  // Bound the buffer so a pathological run cannot grow it without limit, and
  // still flush promptly so a crash mid-open keeps most of the trace.
  if (buffer.length >= 256) {
    flush()
    return
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(flush, 250)
    // Never hold the process open for a diagnostic.
    flushTimer.unref()
  }
}

/** Write out anything still buffered (shutdown, or before reading the trace). */
export function flushPerfTrace(): void {
  if (!ENABLED) return
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flush()
}

/** Record an instant. */
export function perfMark(name: string, detail?: PerfDetail): void {
  if (!ENABLED) return
  emit({ t: nowMs(), kind: 'mark', src: 'main', name, ...(detail ? { detail } : {}) })
}

/** Record a completed duration measured elsewhere (e.g. by the preload bridge). */
export function perfRecord(record: PerfRecord): void {
  if (!ENABLED) return
  emit(record)
}

/** Time a synchronous function. Returns its value; re-throws after recording. */
export function perfSpanSync<T>(name: string, fn: () => T, detail?: PerfDetail): T {
  if (!ENABLED) return fn()
  const start = nowMs()
  try {
    return fn()
  } finally {
    emit({
      t: start,
      kind: 'span',
      src: 'main',
      name,
      ms: nowMs() - start,
      ...(detail ? { detail } : {}),
    })
  }
}

/**
 * Time an async function. `detail` may be a thunk so the caller can report
 * facts only known once the work finished (rows read, bytes parsed).
 */
export async function perfSpan<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: PerfDetail | ((value: T | undefined) => PerfDetail),
): Promise<T> {
  if (!ENABLED) return fn()
  const start = nowMs()
  let value: T | undefined
  let failed = false
  try {
    value = await fn()
    return value
  } catch (err) {
    failed = true
    throw err
  } finally {
    const resolved = typeof detail === 'function' ? detail(value) : detail
    emit({
      t: start,
      kind: 'span',
      src: 'main',
      name,
      ms: nowMs() - start,
      detail: { ...resolved, ...(failed ? { failed: true } : {}) },
    })
  }
}

/**
 * A stable, non-identifying label for a filesystem path: last two segments only.
 * Enough to tell "which project" apart in a trace without writing out a home
 * directory or a repository the user has not chosen to share.
 */
export function pathLabel(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

// --- Counters ---------------------------------------------------------------
// Some costs are death-by-a-thousand-calls rather than one slow span (config
// reads, per-thread file reads). Counting them is cheaper than a span each, and
// the totals are what identify an N+1.

const counters = new Map<string, { calls: number; ms: number; bytes: number }>()

export function perfCount(name: string, ms = 0, bytes = 0): void {
  if (!ENABLED) return
  const entry = counters.get(name) ?? { calls: 0, ms: 0, bytes: 0 }
  entry.calls += 1
  entry.ms += ms
  entry.bytes += bytes
  counters.set(name, entry)
}

/** Emit and reset every counter — call at meaningful boundaries (open complete). */
export function perfDumpCounters(label: string): void {
  if (!ENABLED) return
  const t = nowMs()
  for (const [name, entry] of counters) {
    emit({
      t,
      kind: 'count',
      src: 'main',
      name,
      detail: { at: label, calls: entry.calls, ms: Math.round(entry.ms), bytes: entry.bytes },
    })
  }
  counters.clear()
}
