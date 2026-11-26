import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@shared/types'
import { importedAgentHistory } from './imported-agent-history.ts'

function message(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  return { id: 'm', content: '', toolCalls: [], createdAt: 0, ...partial }
}

describe('importedAgentHistory', () => {
  it('turns CLI tool calls into a labelled, capped record inside one assistant turn', () => {
    const history = importedAgentHistory('codex', [
      message({ role: 'user', content: 'List the files' }),
      message({
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [
          {
            id: 't1',
            name: 'exec',
            title: 'ls',
            args: 'ls',
            status: 'done',
            result: 'x'.repeat(2_100),
          },
        ],
      }),
      message({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't2', name: 'exec', title: 'cat a', args: 'cat a', status: 'error', result: null },
        ],
      }),
      message({ role: 'error', content: 'rate limited' }),
      message({ role: 'assistant', content: 'Two files.' }),
      message({ role: 'user', content: 'Thanks' }),
    ])

    const texts = history.map((entry) =>
      'content' in entry && typeof entry.content === 'string' ? entry.content : null,
    )
    assert.deepEqual(
      history.map((entry) => entry.role),
      ['user', 'assistant', 'user'],
    )
    assert.match(texts[0] ?? '', /^\[This conversation was imported from Codex\./)
    const answer = texts[1] ?? ''
    assert.match(
      answer,
      /^Looking\.\n\n\[Codex ran ls\]\nx{2000}\n\[100 more characters not shown\]/,
    )
    assert.match(answer, /\[Codex ran cat a, which failed\]\n\nTwo files\.$/)
    assert.deepEqual(history[2], { role: 'user', content: 'Thanks' })
  })
})
