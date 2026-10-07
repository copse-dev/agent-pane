import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BAND_REPRESENTATIVE_MODEL, modelIntellect } from '@copse/llm/model-intellect.ts'
import { computeParetoFrontier } from '@copse/llm/pareto-frontier.ts'
import {
  assessPromptDemand,
  pickPromptModel,
  promptRoutingContext,
} from './prompt-model-routing.ts'

describe('primary prompt model routing', () => {
  it('asks a model about the task rather than applying keyword rules', async () => {
    let received = ''
    const demand = await assessPromptDemand(
      'Rename the whole architecture',
      {
        model: 'fixture',
        provider: {
          async *stream(messages) {
            const message = messages[0]
            if (message?.role === 'user' && typeof message.content === 'string')
              received = message.content
            yield { type: 'text', text: 'top' }
            yield { type: 'done' }
          },
        },
      },
      new AbortController().signal,
    )
    assert.equal(demand, 'top')
    assert.match(received, /Rename the whole architecture/)
    assert.match(received, /short follow-up/)
  })

  it('returns no assessment for malformed replies or provider failures', async () => {
    for (const answer of ['I cannot assess this', '']) {
      const demand = await assessPromptDemand(
        'task',
        {
          model: 'fixture',
          provider: {
            async *stream() {
              if (!answer) throw new Error('offline')
              yield { type: 'text', text: answer }
            },
          },
        },
        new AbortController().signal,
      )
      assert.equal(demand, null)
    }
  })

  it('does not call the assessment provider after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const demand = await assessPromptDemand(
      'task',
      {
        model: 'fixture',
        provider: {
          async *stream() {
            called = true
            yield { type: 'text', text: 'top' }
          },
        },
      },
      controller.signal,
    )
    assert.equal(demand, null)
    assert.equal(called, false)
  })
  const medium = modelIntellect(BAND_REPRESENTATIVE_MODEL.mid)
  const high = modelIntellect(BAND_REPRESENTATIVE_MODEL.top)
  assert.ok(medium !== null && high !== null)
  const pool = computeParetoFrontier([
    { id: 'small', intellect: 1, costPerMTok: 0, local: true },
    { id: 'capable', intellect: medium, costPerMTok: 2 },
    { id: 'frontier', intellect: high, costPerMTok: 8 },
  ])

  it('uses a capable route instead of the cheapest underpowered local model', () => {
    assert.equal(pickPromptModel('mid', pool, 'fallback').model, 'capable')
    assert.equal(pickPromptModel('top', pool, 'fallback').model, 'frontier')
  })

  it('uses included capacity when it meets the requirement', () => {
    const included = computeParetoFrontier([
      ...pool,
      { id: 'acp:claude#frontier', intellect: high, costPerMTok: 0, plan: 'Claude' },
    ])
    assert.equal(pickPromptModel('mid', included, 'fallback').model, 'acp:claude#frontier')
  })

  it('explains unmet demand and uses the strongest available model', () => {
    const result = pickPromptModel(
      'top',
      pool.filter((point) => point.id !== 'frontier'),
      'fallback',
    )
    assert.equal(result.model, 'capable')
    assert.match(result.notice, /no available model meets it/)
  })

  it('reports assessment failure and handles an empty candidate pool', () => {
    const result = pickPromptModel(null, [], 'fallback')
    assert.equal(result.model, 'fallback')
    assert.match(result.notice, /assessment was unavailable/)
    assert.match(pickPromptModel('top', [], 'fallback').notice, /No scored route/)
  })

  it('preserves conversational context for a short follow-up without forwarding tool or system text', () => {
    const context = promptRoutingContext('Yes, do that', [
      { role: 'system', content: 'private system instructions' },
      { role: 'user', content: 'Redesign the transaction isolation layer' },
      { role: 'tool', toolResults: [{ toolCallId: 'x', result: 'private tool output' }] },
      { role: 'assistant', content: 'I propose replacing the locking strategy.' },
    ])
    assert.match(context, /transaction isolation/)
    assert.match(context, /locking strategy/)
    assert.match(context, /Current request:\nYes, do that/)
    assert.doesNotMatch(context, /private/)
  })

  it('bounds the assessment input', () => {
    const context = promptRoutingContext(
      'x'.repeat(100_000),
      Array.from({ length: 100 }, () => ({
        role: 'user' as const,
        content: 'y'.repeat(10_000),
      })),
    )
    assert.ok(context.length < 25_000)
  })
})
