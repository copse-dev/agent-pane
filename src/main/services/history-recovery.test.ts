import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@shared/types'
import { recoverAgentHistory, transcriptBeforePendingTurn } from './history-recovery.ts'

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 1 }
}

function assistantMsg(id: string, content: string, toolCalls: Message['toolCalls'] = []): Message {
  return { id, role: 'assistant', content, toolCalls, createdAt: 2 }
}

describe('transcriptBeforePendingTurn', () => {
  it('drops the trailing user message the dispatching turn is about to send', () => {
    const messages = [userMsg('u1', 'first'), assistantMsg('a1', 'answer'), userMsg('u2', 'second')]

    assert.deepEqual(
      transcriptBeforePendingTurn(messages).map((m) => m.id),
      ['u1', 'a1'],
    )
  })

  it('keeps earlier user turns that never got an answer', () => {
    const messages = [userMsg('u1', 'the lost question'), userMsg('u2', 'continue')]

    assert.deepEqual(
      transcriptBeforePendingTurn(messages).map((m) => m.id),
      ['u1'],
    )
  })

  it('keeps a trailing assistant turn', () => {
    const messages = [userMsg('u1', 'ask'), assistantMsg('a1', 'answer')]

    assert.deepEqual(
      transcriptBeforePendingTurn(messages).map((m) => m.id),
      ['u1', 'a1'],
    )
  })

  it('is empty for an empty transcript', () => {
    assert.deepEqual(transcriptBeforePendingTurn([]), [])
  })
})

describe('recoverAgentHistory', () => {
  it('returns nothing for a fresh thread whose only message is the outgoing prompt', () => {
    assert.deepEqual(recoverAgentHistory([userMsg('u1', 'hello')]), [])
  })

  it('rebuilds the turns a dead run failed to commit', () => {
    const history = recoverAgentHistory([
      userMsg('u1', 'Why does reading outside the project not prompt?'),
      assistantMsg('a1', 'Checking', [
        { id: 'tc-1', name: 'read_file', args: { path: 'a.ts' }, status: 'done', result: 'AAA' },
      ]),
      userMsg('u2', 'continue'),
    ])

    assert.deepEqual(history, [
      { role: 'user', content: 'Why does reading outside the project not prompt?' },
      { role: 'assistant', content: 'Checking' },
      {
        role: 'assistant',
        content: [{ id: 'tc-1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'tc-1', result: 'AAA' }] },
    ])
  })
})
