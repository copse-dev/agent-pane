import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@copse/std/array-utils.ts'
import {
  assessPrReadiness,
  sameReadinessTarget,
  readinessSnapshotSchema,
  type ReadinessSnapshot,
  type ReadinessReceipt,
} from './model.mts'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const now = 1_000_000
const target = { repository: 'example/project', number: 7, headSha: head, baseSha: base }
function snapshot(): ReadinessSnapshot {
  return {
    target,
    confirmedTarget: target,
    observedAt: now,
    complete: true,
    problems: [],
    requirements: [{ key: 'tests', label: 'Required tests', actor: 'ci' }],
    receipts: [
      {
        requirement: 'tests',
        target,
        checkedSha: head,
        source: 'workflow:1/check:tests',
        sequence: 1,
        outcome: 'passed',
        detail: 'Tests passed.',
        url: 'https://example.test/run/1',
      },
    ],
  }
}
function receipt(overrides: Partial<ReadinessReceipt> = {}): ReadinessReceipt {
  return { ...at(snapshot().receipts, 0), ...overrides }
}
const decide = (value: ReadinessSnapshot): ReturnType<typeof assessPrReadiness> =>
  assessPrReadiness(value, now)

describe('current-head PR readiness', () => {
  it('is a pure decision with linked evidence and no input mutation', () => {
    const input = snapshot()
    const before = structuredClone(input)
    const result = decide(input)
    assert.equal(result.state, 'ready')
    assert.equal(result.nextActor, null)
    assert.equal(result.requirements[0]?.evidence[0]?.url, 'https://example.test/run/1')
    assert.deepEqual(input, before)
    assert.deepEqual(decide(input), result)
  })
  for (const [label, wrongTarget] of [
    ['head', { ...target, headSha: 'c'.repeat(40) }],
    ['base', { ...target, baseSha: 'c'.repeat(40) }],
    ['repository', { ...target, repository: 'other/project' }],
    ['PR', { ...target, number: 8 }],
  ] as const) {
    it(`cannot reuse another ${label}'s pass`, () => {
      const input = snapshot()
      input.receipts = [receipt({ target: wrongTarget })]
      const result = decide(input)
      assert.equal(result.state, 'unknown')
      assert.equal(result.historical.length, 1)
      assert.equal(result.requirements[0]?.evidence.length, 0)
      assert.equal(sameReadinessTarget(target, wrongTarget), false)
    })
  }
  it('rejects a falsely attributed checked SHA and unsupported test-merge SHA', () => {
    const input = snapshot()
    input.receipts = [receipt({ checkedSha: 'd'.repeat(40) })]
    assert.equal(decide(input).state, 'unknown')
    assert.equal(decide(input).historical.length, 1)
  })
  it('compares repository identity case insensitively', () => {
    assert.equal(sameReadinessTarget(target, { ...target, repository: 'Example/Project' }), true)
  })
  for (const outcome of ['failed', 'pending', 'unknown', 'skipped'] as const) {
    it(`a newer ${outcome} attempt supersedes an earlier pass regardless of array order`, () => {
      const input = snapshot()
      const newer = receipt({ sequence: 2, outcome })
      for (const receipts of [
        [receipt(), newer],
        [newer, receipt()],
      ]) {
        input.receipts = receipts
        assert.equal(
          decide(input).state,
          outcome === 'failed' ? 'blocked' : outcome === 'pending' ? 'waiting' : 'unknown',
        )
        assert.equal(decide(input).requirements[0]?.evidence.length, 1)
      }
    })
  }
  it('a successful newer attempt clears its own failure', () => {
    const input = snapshot()
    input.receipts = [receipt({ outcome: 'failed' }), receipt({ sequence: 2 })]
    assert.equal(decide(input).state, 'ready')
  })
  it('success from another source does not clear a failure with the same display name', () => {
    const input = snapshot()
    input.receipts = [
      receipt({ outcome: 'failed' }),
      receipt({ source: 'workflow:2/check:tests', sequence: 100 }),
    ]
    assert.equal(decide(input).state, 'blocked')
  })
  it('an identical source/sequence with contradictory results is unknown', () => {
    const input = snapshot()
    input.receipts = [receipt(), receipt({ outcome: 'pending' })]
    assert.equal(decide(input).state, 'unknown')
  })
  for (const outcome of ['failed', 'pending', 'skipped', 'unknown'] as const) {
    it(`CI success cannot replace ${outcome} visual/runtime evidence`, () => {
      const input = snapshot()
      input.requirements.push({ key: 'visual', label: 'Visual review', actor: 'user' })
      input.receipts.push(receipt({ requirement: 'visual', source: 'visual-review', outcome }))
      const result = decide(input)
      assert.notEqual(result.state, 'ready')
      assert.equal(result.nextActor, 'user')
    })
  }
  for (const [label, patch] of [
    ['incomplete observation', { complete: false }],
    ['read error', { problems: ['Could not read requirements.'] }],
    ['unconfirmed target', { confirmedTarget: null }],
    ['head changed during read', { confirmedTarget: { ...target, headSha: 'e'.repeat(40) } }],
    ['base changed during read', { confirmedTarget: { ...target, baseSha: 'e'.repeat(40) } }],
    ['missing inventory', { requirements: [] }],
    ['missing results', { receipts: [] }],
  ] satisfies Array<[string, Partial<ReadinessSnapshot>]>) {
    it(`${label} cannot be green`, () => {
      assert.equal(decide({ ...snapshot(), ...patch }).state, 'unknown')
    })
  }
  it('does not hide failure behind pending or incomplete evidence', () => {
    const input = snapshot()
    input.complete = false
    input.receipts.push(receipt({ source: 'another-source', outcome: 'failed' }))
    input.receipts.push(receipt({ source: 'still-running', outcome: 'pending' }))
    assert.equal(decide(input).state, 'blocked')
    assert.ok(decide(input).problems.length)
  })
  it('requires refresh for expired or future observations and invalid clocks', () => {
    for (const instant of [now + 300_001, now - 1, NaN, Infinity])
      assert.equal(assessPrReadiness(snapshot(), instant).state, 'unknown')
    assert.equal(assessPrReadiness(snapshot(), now + 300_000).state, 'ready')
    assert.equal(assessPrReadiness(snapshot(), now, -1).state, 'unknown')
  })
  it('refuses duplicate requirement identities', () => {
    const input = snapshot()
    input.requirements.push({ key: 'tests', label: 'Another test requirement', actor: 'agent' })
    assert.equal(decide(input).state, 'unknown')
  })
  it('decodes complete snapshots and rejects malformed proof', () => {
    assert.equal(readinessSnapshotSchema.safeParse(snapshot()).success, true)
    for (const input of [
      {},
      { ...snapshot(), target: { ...target, headSha: 'abc' } },
      { ...snapshot(), receipts: [receipt({ sequence: -1 })] },
    ])
      assert.equal(readinessSnapshotSchema.safeParse(input).success, false)
  })
})
