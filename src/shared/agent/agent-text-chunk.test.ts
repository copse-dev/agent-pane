import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planAgentTextChunk, type AgentTextChunkState } from './agent-text-chunk.ts'

describe('planAgentTextChunk', () => {
  it('starts a new message for the first visible text chunk', () => {
    const { plan } = planAgentTextChunk({ msgId: null, toolSinceText: false }, 'Hello')
    assert.deepEqual(plan, {
      action: 'append',
      text: 'Hello',
      startNewMessage: true,
    })
  })

  it('appends whitespace-only chunks to an active message', () => {
    const { plan } = planAgentTextChunk({ msgId: 'msg-1', toolSinceText: false }, '\n\n')
    assert.deepEqual(plan, {
      action: 'append',
      text: '\n\n',
      startNewMessage: false,
    })
  })

  it('ignores whitespace-only chunks before any message exists', () => {
    const { plan } = planAgentTextChunk({ msgId: null, toolSinceText: false }, '\n')
    assert.equal(plan.action, 'ignore')
  })

  it('ignores whitespace-only chunks between tool calls', () => {
    const { plan } = planAgentTextChunk({ msgId: 'msg-1', toolSinceText: true }, '\n')
    assert.equal(plan.action, 'ignore')
  })

  it('finalizes the prior bubble and starts a new one after tool calls', () => {
    const { plan } = planAgentTextChunk({ msgId: 'msg-1', toolSinceText: true }, 'Done')
    assert.deepEqual(plan, {
      action: 'append',
      text: 'Done',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('preserves newline-only deltas during active streaming', () => {
    let state: AgentTextChunkState = { msgId: 'msg-1', toolSinceText: false }
    const chunks = ['## Title', '\n', '- item one', '\n', '- item two']

    const texts: string[] = []
    for (const chunk of chunks) {
      const result = planAgentTextChunk(state, chunk)
      state = result.state
      if (result.plan.action === 'append') texts.push(result.plan.text)
    }

    assert.deepEqual(texts, chunks)
  })
})
