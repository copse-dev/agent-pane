import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '@shared/types'
import { explicitAgentForMessage } from './explicit-agent.ts'

function message(role: Message['role'], toolCalls: Message['toolCalls'] = []): Message {
  return { id: role, role, content: '', toolCalls, createdAt: 1 }
}
const task = {
  id: 'worker',
  name: 'task',
  args: { subagent_type: 'reader' },
  status: 'done' as const,
  result: 'Finding',
}

describe('explicitAgentForMessage', () => {
  it('finds a worker card before a separate final report', () => {
    assert.equal(
      explicitAgentForMessage(
        [message('user'), message('assistant', [task]), message('assistant')],
        2,
      ),
      'reader',
    )
  })

  it('does not cross a newer user request', () => {
    assert.equal(
      explicitAgentForMessage(
        [message('user'), message('assistant', [task]), message('user'), message('assistant')],
        3,
      ),
      undefined,
    )
  })

  it('does not mistake an external task for an explicit native invocation', () => {
    for (const metadata of [
      { kind: 'think' as const },
      { title: 'task' },
      { programmaticName: 'task' },
    ]) {
      assert.equal(
        explicitAgentForMessage(
          [message('user'), message('assistant', [{ ...task, ...metadata }]), message('assistant')],
          2,
        ),
        undefined,
      )
    }
  })

  it('distinguishes parent delegation from a one-shot invocation', () => {
    assert.equal(
      explicitAgentForMessage(
        [
          message('user'),
          message('assistant', [{ ...task, name: 'run_readonly_workers' }, task]),
          message('assistant'),
        ],
        2,
      ),
      undefined,
    )
  })

  it('ignores malformed or absent worker provenance', () => {
    for (const args of [null, 'reader', {}, { subagent_type: '' }]) {
      assert.equal(
        explicitAgentForMessage([message('assistant', [{ ...task, args }])], 0),
        undefined,
      )
    }
    assert.equal(explicitAgentForMessage([message('user')], 0), undefined)
  })
})
