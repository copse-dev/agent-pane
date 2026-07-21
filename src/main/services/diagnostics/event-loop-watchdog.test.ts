import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import {
  EventLoopLagMonitor,
  PhaseRing,
  getStartupPhaseTimeline,
  recordStartupPhase,
  type LagRecord,
  type LagMonitorOptions,
  type MemorySample,
  type PhaseDuration,
} from './event-loop-watchdog.ts'

const MEMORY = { rss: 100 * 1024 * 1024, heapUsed: 40 * 1024 * 1024 }

function makeMonitor(overrides: Partial<LagMonitorOptions> = {}): {
  monitor: EventLoopLagMonitor
  records: LagRecord[]
} {
  const records: LagRecord[] = []
  const monitor = new EventLoopLagMonitor({
    intervalMs: 500,
    warnMs: 250,
    severeMs: 2_000,
    cooldownMs: 5_000,
    memory: (): MemorySample => MEMORY,
    latestPhase: (): string | null => 'window-create',
    recentPhases: (): PhaseDuration[] => [{ phase: 'window-create', ms: 120 }],
    onRecord: (r): void => {
      records.push(r)
    },
    ...overrides,
  })
  return { monitor, records }
}

describe('EventLoopLagMonitor (issue #995)', () => {
  it('does not emit on the priming tick or on healthy ticks', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(505) // 5ms jitter — healthy
    monitor.observe(1_010) // healthy
    assert.equal(records.length, 0)
  })

  it('emits a warn record when a tick arrives past the warn threshold', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(800) // elapsed 800, interval 500 → lag 300 ≥ warn
    assert.equal(records.length, 1)
    assert.equal(at(records, 0).severity, 'warn')
    assert.equal(at(records, 0).lagMs, 300)
    assert.equal(at(records, 0).phase, 'window-create')
    assert.equal(at(records, 0).recentPhases.length, 0) // timeline only on severe
  })

  it('classifies a multi-second stall as severe and includes the phase timeline', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(3_000) // lag 2500 ≥ severe
    assert.equal(records.length, 1)
    assert.equal(at(records, 0).severity, 'severe')
    assert.equal(at(records, 0).lagMs, 2_500)
    assert.deepEqual(at(records, 0).recentPhases, [{ phase: 'window-create', ms: 120 }])
  })

  it('ignores lag below the warn threshold', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(700) // lag 200 < warn 250
    assert.equal(records.length, 0)
  })

  it('clamps an early (negative-drift) tick to no lag', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(1_000)
    monitor.observe(1_400) // elapsed 400 < interval 500 → clamped, no record
    assert.equal(records.length, 0)
  })

  it('coalesces a burst of catch-up ticks into one record within the cooldown', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(3_000) // severe, emitted
    monitor.observe(3_800) // lag 300, within cooldown → suppressed
    monitor.observe(4_600) // lag 300, within cooldown → suppressed
    assert.equal(records.length, 1)
  })

  it('reports how many ticks were coalesced on the next emitted record', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(3_000) // emit #1 (coalesced 0)
    monitor.observe(3_800) // suppressed
    monitor.observe(4_600) // suppressed
    // Advance past the cooldown (last record at 3_000, cooldown 5_000).
    monitor.observe(9_000) // lag 3900, cooldown elapsed → emit #2
    assert.equal(records.length, 2)
    assert.equal(at(records, 0).coalescedCount, 0)
    assert.equal(at(records, 1).coalescedCount, 2)
  })

  it('emits again once the cooldown window has fully elapsed', () => {
    const { monitor, records } = makeMonitor()
    monitor.prime(0)
    monitor.observe(1_000) // lag 500 → warn, emit
    monitor.observe(7_000) // 6s later (> cooldown), lag 5500 → emit
    assert.equal(records.length, 2)
  })
})

describe('PhaseRing (issue #995)', () => {
  it('tracks the latest phase and consecutive durations', () => {
    let t = 0
    const ring = new PhaseRing(8, () => t)
    t = 0
    ring.mark('startup')
    t = 100
    ring.mark('migrations')
    t = 350
    ring.mark('window-create')
    assert.equal(ring.latest(), 'window-create')
    assert.deepEqual(ring.durations(), [
      { phase: 'startup', ms: 100 },
      { phase: 'migrations', ms: 250 },
    ])
  })

  it('is bounded: evicts the oldest markers beyond capacity', () => {
    let t = 0
    const ring = new PhaseRing(3, () => t)
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      t += 10
      ring.mark(name)
    }
    assert.equal(ring.snapshot().length, 3)
    assert.deepEqual(
      ring.snapshot().map((m) => m.phase),
      ['c', 'd', 'e'],
    )
    assert.equal(ring.latest(), 'e')
  })

  it('returns null latest and no durations when empty', () => {
    const ring = new PhaseRing(4, () => 0)
    assert.equal(ring.latest(), null)
    assert.deepEqual(ring.durations(), [])
  })
})

describe('startup phase timeline singleton (issue #995 / #994)', () => {
  it('records phases and exposes consecutive durations', () => {
    // Uses a real monotonic clock; assert on structure, not exact millisecond
    // values, so the test is not timing-flaky.
    recordStartupPhase('phase-under-test-a')
    recordStartupPhase('phase-under-test-b')
    const timeline = getStartupPhaseTimeline()
    const phases = timeline.map((p) => p.phase)
    assert.ok(phases.includes('phase-under-test-a'))
    for (const entry of timeline) {
      assert.equal(typeof entry.ms, 'number')
      assert.ok(entry.ms >= 0)
    }
  })
})
