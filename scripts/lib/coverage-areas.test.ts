import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  areaFloorFailures,
  areaOf,
  formatAreaTable,
  summariseAreas,
  updatedFloors,
} from './coverage-areas.mts'

const root = '/repo'

function entry(covered: number, total: number): Record<string, unknown> {
  return { lines: { covered, total, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 } }
}

const summary: Record<string, unknown> = {
  total: entry(1_150, 1_400),
  '/repo/src/main/ipc/thread-handlers.ts': entry(0, 200),
  '/repo/src/main/ipc/settings-handlers.ts': entry(100, 100),
  '/repo/src/main/services/agent.ts': entry(950, 1_000),
  '/repo/src/main/index.ts': entry(0, 100),
  '/elsewhere/vendor.ts': entry(0, 5_000),
  '/repo/src/broken.ts': { lines: 'no' },
}

describe('coverage areas', () => {
  it('groups by the first three path segments and keeps a high file as its own area', () => {
    assert.equal(areaOf('src/main/services/github/git-service.ts'), 'src/main/services')
    assert.equal(areaOf('src/main/index.ts'), 'src/main/index.ts')
    assert.equal(areaOf('packages/std/src/unknown-value.ts'), 'packages/std/src')
  })

  it('sums lines per area, most uncovered first, ignoring files outside the root', () => {
    assert.deepEqual(summariseAreas(summary, root), [
      { area: 'src/main/ipc', covered: 100, total: 300, files: 2, pct: 33.33 },
      { area: 'src/main/index.ts', covered: 0, total: 100, files: 1, pct: 0 },
      { area: 'src/main/services', covered: 950, total: 1_000, files: 1, pct: 95 },
    ])
  })

  it('fails an area below its floor, and a floored area that is gone, but not one inside tolerance', () => {
    const areas = summariseAreas(summary, root)
    assert.deepEqual(
      areaFloorFailures(
        areas,
        { 'src/main/ipc': 40, 'src/main/services': 95.005, 'src/gone': 1 },
        0.01,
      ),
      ['src/main/ipc: 33.33% is below its floor of 40%', 'src/gone: no files measured (floor 1%)'],
    )
    assert.deepEqual(areaFloorFailures(areas, {}, 0.01), [])
  })

  it('sets floors a margin under the measured figure for the named areas it measured', () => {
    const areas = summariseAreas(summary, root)
    assert.deepEqual(
      updatedFloors(areas, 0.5, {}, ['src/main/ipc', 'src/main/services', 'src/gone']),
      {
        'src/main/ipc': 32.83,
        'src/main/services': 94.5,
      },
    )
  })

  it('keeps an existing floor for an area the run did not measure', () => {
    const areas = summariseAreas(summary, root)
    assert.deepEqual(
      updatedFloors(areas, 0.5, { 'src/gone': 12, 'src/main/ipc': 90 }, ['src/main/ipc']),
      { 'src/main/ipc': 32.83, 'src/gone': 12 },
    )
  })

  it('prints a table that names floors where they exist', () => {
    const table = formatAreaTable(summariseAreas(summary, root), { 'src/main/ipc': 32 }, 2)
    assert.equal(
      table,
      [
        '| Area | Uncovered lines | Line coverage | Floor | Files |',
        '| --- | ---: | ---: | ---: | ---: |',
        '| `src/main/ipc` | 200 | 33.33% | 32% | 2 |',
        '| `src/main/index.ts` | 100 | 0.00% |  | 1 |',
      ].join('\n'),
    )
  })
})
