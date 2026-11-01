import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import {
  AcpStartupBuffer,
  ACP_STARTUP_BUFFER_MAX_BYTES,
  ACP_STARTUP_BUFFER_MAX_UPDATES,
} from './acp-startup-buffer.ts'

const text = (value: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
})

describe('AcpStartupBuffer', () => {
  it('bounds all session IDs together and releases buffered updates on overflow', () => {
    const buffer = new AcpStartupBuffer()
    for (let index = 0; index < ACP_STARTUP_BUFFER_MAX_UPDATES; index++) {
      assert.equal(buffer.enqueue(String(index), text('payload')), null)
    }
    assert.match(buffer.enqueue('overflow', text('payload'))?.message ?? '', /buffer limit/)
    assert.deepEqual(buffer.take('0'), [])
  })

  it('bounds bytes even when the update count is small', () => {
    const buffer = new AcpStartupBuffer()
    assert.match(
      buffer.enqueue('opening', text('x'.repeat(ACP_STARTUP_BUFFER_MAX_BYTES / 2)))?.message ?? '',
      /buffer limit/,
    )
    assert.deepEqual(buffer.take('opening'), [])
  })

  it('preserves selected-session ordering and releases other sessions', () => {
    const buffer = new AcpStartupBuffer()
    buffer.enqueue('selected', text('first'))
    buffer.enqueue('other', text('ignored'))
    buffer.enqueue('selected', text('second'))
    assert.deepEqual(buffer.take('selected'), [text('first'), text('second')])
    assert.deepEqual(buffer.take('other'), [])
  })

  it('discards large load replays incrementally while retaining evidence and state', () => {
    const buffer = new AcpStartupBuffer()
    buffer.beginReplay('restored')
    const commands: SessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'review', description: 'Review' }],
    }
    buffer.enqueue('restored', commands)
    for (let index = 0; index < ACP_STARTUP_BUFFER_MAX_UPDATES * 2; index++) {
      assert.equal(buffer.enqueue('restored', text('x'.repeat(4096))), null)
    }
    assert.equal(buffer.replayFoundConversation(), false)
    buffer.enqueue('restored', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'original prompt' },
    })
    assert.equal(buffer.replayFoundConversation(), true)
    assert.deepEqual(buffer.take('restored'), [commands])
    assert.equal(buffer.replayFoundConversation(), false)
  })

  it('clears failed-attempt payloads and replay evidence', () => {
    const buffer = new AcpStartupBuffer()
    buffer.enqueue('old', text('old'))
    buffer.beginReplay('restored')
    buffer.enqueue('restored', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'original prompt' },
    })
    buffer.clear()
    assert.equal(buffer.replayFoundConversation(), false)
    assert.deepEqual(buffer.take('old'), [])
    assert.deepEqual(buffer.take('restored'), [])
  })
})
