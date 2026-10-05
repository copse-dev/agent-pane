import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { median, specDurations } from './e2e-shard-weights.mts'

describe('e2e shard weights', () => {
  it('times passing specs per runner slot and ignores failures and cut-off runs', () => {
    const esc = String.fromCharCode(27)
    const log = [
      '2026-10-03T11:18:49.1693473Z [0-0] RUNNING in chrome(152) - file:///tests/e2e/a.e2e.ts',
      `2026-10-03T11:19:07.6693473Z ${esc}[32m[0-0] PASSED${esc}[39m in chrome(152) - file:///tests/e2e/a.e2e.ts`,
      '2026-10-03T11:19:08.0000000Z [0-1] RUNNING in chrome(152) - file:///tests/e2e/b.e2e.ts',
      '2026-10-03T11:19:38.0000000Z [0-1] FAILED in chrome(152) - file:///tests/e2e/b.e2e.ts',
      '2026-10-03T11:19:39.0000000Z [0-2] RUNNING in chrome(152) - file:///tests/e2e/c.e2e.ts',
      // A second attempt reuses slot numbers.
      '2026-10-03T11:30:00.0000000Z [0-0] RUNNING in chrome(152) - file:///tests/e2e/a.e2e.ts',
      '2026-10-03T11:30:20.0000000Z [0-0] PASSED in chrome(152) - file:///tests/e2e/a.e2e.ts',
    ].join('\n')
    assert.deepEqual([...specDurations(log)], [['tests/e2e/a.e2e.ts', [18.5, 20]]])
  })

  it('takes the middle value, averaging the middle pair', () => {
    assert.equal(median([9, 1, 5]), 5)
    assert.equal(median([4, 1, 3, 2]), 2.5)
  })
})
