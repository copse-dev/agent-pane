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

  it('keeps the file paths dropped tool calls touched, so a retry knows where to look', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Still working', status: 'in_progress' }]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      {
        role: 'assistant',
        content: [
          { id: 'tc1', name: 'read_file', args: { path: 'src/roadmap-pane.ts' } },
          { id: 'tc2', name: 'search_codebase', args: { path: 'src/complexity.ts', query: 'x' } },
        ],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'file contents' }] },
      { role: 'assistant', content: 'Looked at the files.' },
      { role: 'user', content: 'continue' },
    ]
    compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1 })
    const sys = at(messages, 0)
    const sysText = 'content' in sys && typeof sys.content === 'string' ? sys.content : ''
    assert.match(sysText, /Files touched/)
    assert.match(sysText, /src\/roadmap-pane\.ts/)
    assert.match(sysText, /src\/complexity\.ts/)
  })

  it('accumulates touched files across repeated compactions instead of losing them', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Still working', status: 'in_progress' }]
    const first: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      { role: 'assistant', content: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'contents' }] },
      { role: 'assistant', content: 'Read a.ts.' },
      { role: 'user', content: 'continue' },
    ]
    compactAtTodoBoundary(first, todos, { keepRecentPairs: 1 })

    const second: LLMMessage[] = [
      at(first, 0),
      { role: 'user', content: 'keep going' },
      { role: 'assistant', content: [{ id: 'tc2', name: 'read_file', args: { path: 'b.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc2', result: 'contents' }] },
      { role: 'assistant', content: 'Read b.ts.' },
      { role: 'user', content: 'continue' },
    ]
    compactAtTodoBoundary(second, todos, { keepRecentPairs: 1 })

    const sys = at(second, 0)
    const sysText = 'content' in sys && typeof sys.content === 'string' ? sys.content : ''
    assert.match(sysText, /a\.ts/)
    assert.match(sysText, /b\.ts/)
    // Exactly one files-touched block, not one stacked on top of the last.
    assert.equal(sysText.match(/Files touched/g)?.length, 1)
  })
})
