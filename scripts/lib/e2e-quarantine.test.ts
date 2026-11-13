import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ExclusionRegistry } from './e2e-exclusions.mts'
import {
  HISTORY_LIMIT,
  QUARANTINE_MARKER,
  appendNight,
  nightResults,
  passStreaks,
  quarantineHistorySchema,
  quarantinedSpecs,
  type QuarantineHistory,
  type QuarantineNight,
} from './e2e-quarantine.mts'

const flaky = 'tests/e2e/flaky.e2e.ts'
const other = 'tests/e2e/other.e2e.ts'
const commit = 'a'.repeat(40)

function entry(
  spec: string,
  category: ExclusionRegistry['entries'][number]['category'],
  markers: string[],
): ExclusionRegistry['entries'][number] {
  return {
    spec,
    category,
    reason: 'reason',
    tracker: 'https://github.com/copse-dev/agent-pane/issues/2719',
    ownerRole: 'owner',
    recordedOn: '2026-11-01',
    reviewBy: '2026-11-08',
    coverage: 'coverage',
    markers,
  }
}

function outcome(
  spec: string,
  result: 'running' | 'passed' | 'failed',
  attempt = 1,
): Parameters<typeof nightResults>[1][number] {
  return {
    version: 1,
    spec,
    attempt,
    outcome: result,
    exitCode: result === 'running' ? null : result === 'passed' ? 0 : 1,
    durationSeconds: result === 'running' ? null : 3,
    failureClass: result === 'failed' ? 'unclassified' : null,
    runId: '1',
    runAttempt: '1',
    shard: '1',
    commit,
  }
}

function night(runId: string, results: QuarantineNight['results']): QuarantineNight {
  return { runId, runAttempt: '1', date: '2026-11-08', commit, results }
}

describe('quarantinedSpecs', () => {
  it('selects only config-excluded quarantine entries', () => {
    const registry: ExclusionRegistry = {
      version: 1,
      entries: [
        entry(flaky, 'quarantine', [QUARANTINE_MARKER]),
        entry(other, 'quarantine', ['this.skip']),
        entry('tests/e2e/portrait.e2e.ts', 'environment', [QUARANTINE_MARKER]),
        entry('tests/e2e/model.e2e.ts', 'external-service', [
          QUARANTINE_MARKER,
          'wdio.conf.ts: exclude',
        ]),
      ],
    }
    assert.deepEqual(quarantinedSpecs(registry), [flaky])
  })

  it('returns nothing when no spec is quarantined', () => {
    assert.deepEqual(quarantinedSpecs({ version: 1, entries: [] }), [])
  })
})

describe('nightResults', () => {
  it('counts a first-attempt pass, and treats failures, crashes and absences as not passing', () => {
    assert.deepEqual(
      nightResults(
        [flaky, other, 'tests/e2e/crashed.e2e.ts', 'tests/e2e/absent.e2e.ts'],
        [
          outcome(flaky, 'running'),
          outcome(flaky, 'passed'),
          outcome(other, 'failed'),
          outcome('tests/e2e/crashed.e2e.ts', 'running'),
        ],
      ),
      {
        [flaky]: 'passed',
        [other]: 'failed',
        'tests/e2e/crashed.e2e.ts': 'missing',
        'tests/e2e/absent.e2e.ts': 'missing',
      },
    )
  })

  it('ignores retry attempts so a streak counts only first-attempt passes', () => {
    assert.deepEqual(
      nightResults([flaky], [outcome(flaky, 'failed'), outcome(flaky, 'passed', 2)]),
      { [flaky]: 'failed' },
    )
    assert.deepEqual(nightResults([flaky], [outcome(flaky, 'passed', 2)]), {
      [flaky]: 'missing',
    })
  })
})

describe('appendNight', () => {
  it('starts a history, replaces a rerun of the same run and keeps the newest nights', () => {
    const first = appendNight(null, night('1', { [flaky]: 'failed' }))
    assert.deepEqual(
      first.nights.map((n) => n.runId),
      ['1'],
    )
    const rerun = appendNight(first, night('1', { [flaky]: 'passed' }))
    assert.deepEqual(rerun.nights, [night('1', { [flaky]: 'passed' })])
    let history: QuarantineHistory = { version: 1, nights: [] }
    for (let id = 0; id < HISTORY_LIMIT + 5; id++)
      history = appendNight(history, night(String(id), { [flaky]: 'passed' }))
    assert.equal(history.nights.length, HISTORY_LIMIT)
    assert.equal(history.nights.at(-1)?.runId, String(HISTORY_LIMIT + 4))
    assert.ok(quarantineHistorySchema.safeParse(history).success)
  })
})

describe('passStreaks', () => {
  it('counts consecutive passes back from the newest night', () => {
    const history: QuarantineHistory = {
      version: 1,
      nights: [
        night('1', { [flaky]: 'passed', [other]: 'passed' }),
        night('2', { [flaky]: 'failed', [other]: 'passed' }),
        night('3', { [flaky]: 'passed', [other]: 'passed' }),
        night('4', { [flaky]: 'passed', [other]: 'missing' }),
      ],
    }
    assert.deepEqual(
      passStreaks(history, [flaky, other]),
      new Map([
        [flaky, 2],
        [other, 0],
      ]),
    )
  })

  it('ends a streak at a night that did not record the spec', () => {
    const history: QuarantineHistory = {
      version: 1,
      nights: [
        night('1', { [flaky]: 'passed' }),
        night('2', {}),
        night('3', { [flaky]: 'passed' }),
      ],
    }
    assert.deepEqual(passStreaks(history, [flaky]), new Map([[flaky, 1]]))
    assert.deepEqual(passStreaks({ version: 1, nights: [] }, [flaky]), new Map([[flaky, 0]]))
  })
})
