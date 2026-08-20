/**
 * Read a `COPSE_PERF=1` trace and print where an app open actually went.
 *
 * Usage:
 *   node scripts/perf-report.mts <trace.ndjson>
 *
 * The trace interleaves three producers on one wall-clock axis (see
 * `src/main/services/diagnostics/perf-trace.ts`): main-process spans and marks,
 * preload `invoke` spans (renderer-observed latency), and renderer marks for the
 * boundaries of user-visible actions. This report reduces that to the four
 * questions worth asking:
 *
 *   1. How long was the open, end to end?
 *   2. Which named phases inside it dominate?
 *   3. Which IPC channels cost the most — by total time and by call count?
 *   4. Where does renderer-observed latency exceed main's own handler time?
 *      (That gap is queueing or payload size, not the handler.)
 */

import { readFileSync } from 'node:fs'

interface Record_ {
  t: number
  kind: 'mark' | 'span' | 'count'
  src: 'main' | 'renderer' | 'preload'
  name: string
  ms?: number
  detail?: Record<string, string | number | boolean | undefined>
}

/** Trace lines are our own output, but a truncated final line is normal. */
function isRecord(value: unknown): value is Record_ {
  if (typeof value !== 'object' || value === null) return false
  const t: unknown = Reflect.get(value, 't')
  const name: unknown = Reflect.get(value, 'name')
  return typeof t === 'number' && typeof name === 'string'
}

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/perf-report.mts <trace.ndjson>')
  process.exit(2)
}

const records: Record_[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line.replace(/^\[perf\] /, ''))
      return isRecord(parsed) ? [parsed] : []
    } catch {
      return []
    }
  })
  .sort((a, b) => a.t - b.t)

if (records.length === 0) {
  console.error(`No trace records in ${file}. Was COPSE_PERF=1 set?`)
  process.exit(1)
}

const ms = (n: number): string => `${n.toFixed(0).padStart(7)}ms`
const spans = records.filter((r) => r.kind === 'span')
const counts = records.filter((r) => r.kind === 'count')

function detailOf(r: Record_): string {
  if (!r.detail) return ''
  const parts = Object.entries(r.detail)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
  return parts.length > 0 ? `  (${parts.join(' ')})` : ''
}

console.log(`\n=== Trace: ${file} — ${String(records.length)} records ===\n`)

// 1 + 2. The named phases, in the order they happened.
console.log('--- Timeline (spans and marks, wall-clock from main arming) ---')
for (const r of records) {
  if (r.kind === 'count') continue
  // Per-call IPC marks are summarised below; listing every one here would bury
  // the phases that give the timeline its shape.
  if (r.name.startsWith('ipc:')) continue
  const dur = r.kind === 'span' && r.ms !== undefined ? ms(r.ms) : '         '
  console.log(`${ms(r.t)}  ${dur}  ${r.src.padEnd(8)} ${r.name}${detailOf(r)}`)
}

// 3. Where the IPC time went. Counters carry per-channel totals from main.
console.log('\n--- IPC channels by total main-process handler time ---')
const channelTotals = counts
  .filter((r) => r.name.startsWith('ipc:'))
  .map((r) => ({
    name: r.name.slice(4),
    at: String(r.detail?.['at'] ?? ''),
    calls: Number(r.detail?.['calls'] ?? 0),
    ms: Number(r.detail?.['ms'] ?? 0),
  }))
  .sort((a, b) => b.ms - a.ms)
console.log('   total    calls  per-call  phase           channel')
for (const c of channelTotals.slice(0, 25)) {
  const per = c.calls > 0 ? c.ms / c.calls : 0
  console.log(
    `${ms(c.ms)}  ${String(c.calls).padStart(7)}  ${per.toFixed(1).padStart(8)}  ${c.at.padEnd(14)}  ${c.name}`,
  )
}

// The non-IPC counters (thread prefetch, storage) answer "death by a thousand
// calls?" for the disk paths.
const other = counts.filter((r) => !r.name.startsWith('ipc:'))
if (other.length > 0) {
  console.log('\n--- Disk / store counters ---')
  for (const r of other) {
    const calls = Number(r.detail?.['calls'] ?? 0)
    const total = Number(r.detail?.['ms'] ?? 0)
    const bytes = Number(r.detail?.['bytes'] ?? 0)
    const mb = bytes / (1024 * 1024)
    console.log(
      `${ms(total)}  ${String(calls).padStart(7)} calls  ${mb.toFixed(1).padStart(8)} MB  ${String(r.detail?.['at'] ?? '')}  ${r.name}`,
    )
  }
}

// 4. Renderer-observed wait vs main handler time, per channel.
console.log('\n--- Renderer-observed IPC latency (preload invoke) ---')
const invokes = new Map<string, { calls: number; ms: number; max: number }>()
for (const r of spans) {
  if (r.src !== 'preload' || !r.name.startsWith('invoke:') || r.ms === undefined) continue
  const key = r.name.slice(7)
  const entry = invokes.get(key) ?? { calls: 0, ms: 0, max: 0 }
  entry.calls += 1
  entry.ms += r.ms
  entry.max = Math.max(entry.max, r.ms)
  invokes.set(key, entry)
}
// Counters are dumped (and reset) at each boundary, so one channel can appear
// once per phase. Sum them before comparing against the renderer-observed total,
// which spans the whole run.
const mainByChannel = new Map<string, number>()
for (const c of channelTotals) mainByChannel.set(c.name, (mainByChannel.get(c.name) ?? 0) + c.ms)
console.log('   waited    calls   slowest   main-side   gap  channel')
for (const [name, e] of [...invokes].sort((a, b) => b[1].ms - a[1].ms).slice(0, 20)) {
  const mainMs = mainByChannel.get(name) ?? 0
  const gap = e.ms - mainMs
  console.log(
    `${ms(e.ms)}  ${String(e.calls).padStart(7)}  ${ms(e.max)}  ${ms(mainMs)}  ${ms(gap)}  ${name}`,
  )
}
console.log(
  '\n  "gap" is renderer wait minus main handler time: queueing behind other\n' +
    '  main-process work, plus structured-clone of the payload both ways.\n',
)
