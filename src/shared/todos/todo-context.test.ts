import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { compactAtTodoBoundary } from './todo-context.ts'
import type { LLMMessage } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'

describe('compactAtTodoBoundary', () => {
  it('pins todos in system prompt and drops old assistant turns', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'Done step', status: 'completed' },
      { id: '2', content: 'Next step', status: 'in_progress' },
    ]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      { role: 'assistant', content: 'Starting.' },
      { role: 'assistant', content: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'file contents' }] },
      { role: 'assistant', content: 'Step one done.' },
      { role: 'user', content: 'continue' },
    ]
    const beforeLen = messages.length
    const changed = compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1 })
    assert.equal(changed, true)
    assert.ok(messages.length < beforeLen)
    const sys = at(messages, 0)
    assert.equal(sys.role, 'system')
    const sysText = 'content' in sys && typeof sys.content === 'string' ? sys.content : ''
    assert.match(sysText, /Active plan/)
    assert.match(sysText, /Next step/)
  })
})
