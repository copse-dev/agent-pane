import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '../types/thread.ts'
import {
  collectThreadPrRefs,
  describeThreadPrStatus,
  formatThreadPrStatus,
  normalizePrLifecycleState,
  summarizeThreadPrStatus,
} from './thread-pr-status.ts'

function thread(
  overrides: Partial<Pick<Thread, 'messages' | 'remoteAgentLink'>> = {},
): Pick<Thread, 'messages' | 'remoteAgentLink'> {
  const base: Pick<Thread, 'messages' | 'remoteAgentLink'> = {
    messages: overrides.messages ?? [],
  }
  if (overrides.remoteAgentLink) base.remoteAgentLink = overrides.remoteAgentLink
  return base
}

function assistant(id: string, content: string, createdAt: number): Thread['messages'][number] {
  return { id, role: 'assistant', content, toolCalls: [], createdAt }
}

describe('normalizePrLifecycleState', () => {
  it('maps open / merged / closed casings', () => {
    assert.equal(normalizePrLifecycleState('OPEN'), 'open')
    assert.equal(normalizePrLifecycleState('open'), 'open')
    assert.equal(normalizePrLifecycleState('MERGED'), 'merged')
    assert.equal(normalizePrLifecycleState('CLOSED'), 'closed')
  })

  it('treats REST closed+merged as merged', () => {
    assert.equal(normalizePrLifecycleState('CLOSED', true), 'merged')
    assert.equal(normalizePrLifecycleState('closed', true), 'merged')
  })

  it('returns unknown for empty or unexpected values', () => {
    assert.equal(normalizePrLifecycleState(''), 'unknown')
    assert.equal(normalizePrLifecycleState('DRAFT'), 'unknown')
  })
})

describe('collectThreadPrRefs', () => {
  it('collects unique PR URLs from messages and the durable agent link', () => {
    const refs = collectThreadPrRefs(
      thread({
        messages: [
          assistant(
            'm1',
            'Opened https://github.com/o/r/pull/1 and https://github.com/o/r/pull/2',
            1,
          ),
          assistant('m2', 'Same again https://github.com/o/r/pull/1/files', 2),
        ],
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'a1',
          prUrl: 'https://github.com/o/r/pull/3',
          createdAt: 1,
        },
      }),
    )
    assert.deepEqual(
      refs.map((r) => r.number),
      [1, 2, 3],
    )
  })

  it('dedupes the agent link when the same PR already appears in chat', () => {
    const refs = collectThreadPrRefs(
      thread({
        messages: [assistant('m1', 'https://github.com/o/r/pull/9', 1)],
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'a1',
          prUrl: 'https://github.com/o/r/pull/9',
          createdAt: 1,
        },
      }),
    )
    assert.equal(refs.length, 1)
    assert.equal(refs[0]?.number, 9)
  })
})

describe('summarizeThreadPrStatus + format/describe', () => {
  it('surfaces a single open PR as #N', () => {
    const rollup = summarizeThreadPrStatus(['open'], [{ number: 42 }])
    assert.ok(rollup)
    assert.deepEqual(rollup, {
      kind: 'open',
      openCount: 1,
      totalCount: 1,
      primaryNumber: 42,
    })
    assert.equal(formatThreadPrStatus(rollup), '#42')
    assert.match(describeThreadPrStatus(rollup), /#42/)
  })

  it('counts multiple open PRs and prefers open over merged', () => {
    const rollup = summarizeThreadPrStatus(
      ['open', 'merged', 'open'],
      [{ number: 1 }, { number: 2 }],
    )
    assert.ok(rollup)
    assert.deepEqual(rollup, { kind: 'open', openCount: 2, totalCount: 3 })
    assert.equal(formatThreadPrStatus(rollup), '2 open')
  })

  it('reports all merged when every known PR is merged', () => {
    const one = summarizeThreadPrStatus(['merged'])
    assert.ok(one)
    assert.deepEqual(one, { kind: 'merged', totalCount: 1 })
    assert.equal(formatThreadPrStatus(one), 'merged')

    const many = summarizeThreadPrStatus(['merged', 'merged'])
    assert.ok(many)
    assert.deepEqual(many, { kind: 'merged', totalCount: 2 })
    assert.equal(formatThreadPrStatus(many), 'all merged')
    assert.match(describeThreadPrStatus(many), /All linked/)
  })

  it('falls back to closed when nothing is open and not all are merged', () => {
    const rollup = summarizeThreadPrStatus(['closed', 'merged'])
    assert.ok(rollup)
    assert.deepEqual(rollup, { kind: 'closed', totalCount: 2 })
    assert.equal(formatThreadPrStatus(rollup), 'all closed')
  })

  it('ignores unknown states and returns null when none are known', () => {
    assert.equal(summarizeThreadPrStatus(['unknown', 'unknown']), null)
    assert.equal(summarizeThreadPrStatus([]), null)
  })
})
