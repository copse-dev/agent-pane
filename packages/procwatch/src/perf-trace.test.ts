import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

// The tracer reads its flag when the module loads, so the environment is set
// before the import. The test runner gives each file its own process.
const dir = mkdtempSync(join(tmpdir(), 'perf-trace-'))
const out = join(dir, 'trace.ndjson')
process.env['COPSE_PERF'] = '1'
process.env['COPSE_PERF_OUT'] = out
const { armPerfTrace, flushPerfTrace, perfSyncSpan } = await import('./perf-trace.ts')

interface Record {
  kind: string
  name: string
  ms?: number
  t: number
  detail?: { [key: string]: unknown }
}

function readRecords(): Record[] {
  flushPerfTrace()
  return readFileSync(out, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): Record => {
      const parsed: unknown = JSON.parse(line)
      assert.ok(typeof parsed === 'object' && parsed !== null)
      return { kind: '', name: '', t: 0, ...parsed }
    })
}

function blockLoop(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Busy wait: the point is to hold the event loop.
  }
}

describe('perf trace', () => {
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('times a synchronous call without changing its result or ordering', () => {
    armPerfTrace()
    const order: string[] = []
    const value = perfSyncSpan('test:sync', () => {
      order.push('inside')
      return 42
    })
    order.push('after')
    assert.equal(value, 42)
    assert.deepEqual(order, ['inside', 'after'])
    const span = readRecords().find((record) => record.name === 'test:sync')
    assert.equal(span?.kind, 'span')
    assert.equal(typeof span.ms, 'number')
  })

  it('records the span and rethrows when the call throws', () => {
    assert.throws(
      () =>
        perfSyncSpan('test:throws', () => {
          throw new Error('boom')
        }),
      /boom/,
    )
    assert.ok(readRecords().some((record) => record.name === 'test:throws'))
  })

  it('records a stretch where the event loop was blocked as loop:stall', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    blockLoop(200)
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    const stalls = readRecords().filter((record) => record.name === 'loop:stall')
    assert.ok(
      stalls.some((record) => (record.ms ?? 0) >= 150),
      `expected a stall of at least 150 ms, got ${JSON.stringify(stalls.map((s) => s.ms))}`,
    )
  })
})
