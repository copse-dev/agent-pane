import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildHeadlessTurnEvents } from './bench-agent-lib.mts'
import { headlessEventSchema, HEADLESS_PROTOCOL_VERSION } from '@copse/agent/headless-contract.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'

// The bench harness is the headless contract's first conformance consumer
// (#1079, Phase 1): it must turn the loop's native chunk stream into a valid
// canonical `turn_start … turn_end` envelope. These tests drive the assembly
// helper directly with representative chunks so a projection regression is caught
// without spawning the whole agent loop.

const sampleChunks: AgentStreamChunk[] = [
  { type: 'text', text: 'Looking at the repo.' },
  { type: 'tool_call', toolCall: { id: 'tc-1', name: 'read_file', args: { path: 'test.js' } } },
  { type: 'tool_result', toolCallId: 'tc-1', result: 'file contents', isError: false },
  { type: 'usage', model: 'mock', inputTokens: 10, outputTokens: 5 },
  { type: 'text', text: 'Fixed the off-by-one.' },
  { type: 'done', stopReason: 'stop' },
]

describe('bench-agent headless conformance', () => {
  it('assembles a valid turn envelope from a completed run', () => {
    const events = buildHeadlessTurnEvents({
      threadId: 'off-by-one-sum',
      turnId: 'off-by-one-sum-t1',
      chunks: sampleChunks,
      outcome: 'completed',
      stopReason: 'end_turn',
    })

    // Every event validates against the published contract schema.
    for (const event of events) assert.doesNotThrow(() => headlessEventSchema.parse(event))

    const first = events[0]
    const last = events.at(-1)
    assert.ok(first && first.type === 'turn_start')
    assert.equal(first.protocolVersion, HEADLESS_PROTOCOL_VERSION)
    assert.ok(last && last.type === 'turn_end')
    assert.equal(last.outcome, 'completed')
    assert.equal(last.stopReason, 'end_turn')

    const toolCall = events.find((e) => e.type === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'tc-1')
    const toolResult = events.find((e) => e.type === 'tool_result')
    assert.ok(toolResult)
    assert.equal(toolResult.status, 'done')
    // usage / done chunks carry no contract event.
    assert.equal(
      events.filter((e) => e.type === 'message').length,
      2,
      'both text chunks project to message events',
    )
  })

  it('records a timeout as a failed turn', () => {
    const events = buildHeadlessTurnEvents({
      threadId: 't',
      turnId: 't-t1',
      chunks: [{ type: 'text', text: 'partial' }],
      outcome: 'failed',
      stopReason: 'timeout',
    })
    const last = events.at(-1)
    assert.ok(last && last.type === 'turn_end')
    assert.equal(last.outcome, 'failed')
    assert.equal(last.stopReason, 'timeout')
  })

  it('throws on a malformed projected event (the conformance guard)', () => {
    // A chunk that would project to an event missing a required field must be
    // rejected by the in-builder validation. `tool_call` with a non-string name
    // is the simplest way to force an invalid projection.
    const bad = [
      { type: 'tool_call', toolCall: { id: 'x', name: 42 as unknown as string, args: {} } },
    ] as AgentStreamChunk[]
    assert.throws(() =>
      buildHeadlessTurnEvents({
        threadId: 't',
        turnId: 't-t1',
        chunks: bad,
        outcome: 'completed',
        stopReason: 'end_turn',
      }),
    )
  })
})
