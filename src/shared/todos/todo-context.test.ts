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

  it('keeps the paths of edit tools, which is where a model that knows the codebase spends its calls', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Still working', status: 'in_progress' }]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      {
        role: 'assistant',
        content: [
          { id: 'tc1', name: 'str_replace', args: { path: 'src/lib.rs', old_string: 'a' } },
          { id: 'tc2', name: 'read_staged_diff', args: { path: 'src/webview.rs' } },
          { id: 'tc3', name: 'rename_file', args: { from: 'src/old.rs', to: 'src/new.rs' } },
          { id: 'tc4', name: 'explore', args: { query: 'runtime trait', paths: ['crates/rt'] } },
        ],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'edited' }] },
      { role: 'assistant', content: 'Edited the files.' },
      { role: 'user', content: 'continue' },
    ]
    compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1 })
    const sys = at(messages, 0)
    const sysText = 'content' in sys && typeof sys.content === 'string' ? sys.content : ''
    for (const path of ['src/lib.rs', 'src/webview.rs', 'src/old.rs', 'src/new.rs', 'crates/rt']) {
      assert.match(sysText, new RegExp(path.replace(/[./]/g, '\\$&')))
    }
  })

  it('records nothing for a tool whose args only name a pattern, never a location', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Still working', status: 'in_progress' }]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      {
        role: 'assistant',
        content: [{ id: 'tc1', name: 'find_files', args: { pattern: '*.rs' } }],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'many files' }] },
      { role: 'assistant', content: 'Searched.' },
      { role: 'user', content: 'continue' },
    ]
    compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1 })
    const sys = at(messages, 0)
    const sysText = 'content' in sys && typeof sys.content === 'string' ? sys.content : ''
    assert.doesNotMatch(sysText, /Files touched/)
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

  it('leaves history alone when the conversation is nowhere near its budget', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Next step', status: 'in_progress' }]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      { role: 'assistant', content: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'file contents' }] },
      { role: 'assistant', content: 'Step one done.' },
      { role: 'user', content: 'continue' },
    ]
    const beforeLen = messages.length

    // The fill ratio observed in the thread that motivated the gate: ~1% of a
    // 1M-token budget, where dropping history buys nothing at all.
    const changed = compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1, fillRatio: 0.01 })

    assert.equal(changed, false)
    assert.equal(messages.length, beforeLen, 'nothing dropped without budget pressure')
  })

  it('still pins the plan on the gated path, so the prompt never holds a stale plan', () => {
    // The pinned blocks are written at the end of the compaction path, so an
    // early return that skips them would leave the system prompt advertising
    // whatever plan was pinned last — the failure mode this ordering prevents.
    const todos: TodoItem[] = [
      { id: '1', content: 'Old step', status: 'completed' },
      { id: '2', content: 'Freshly planned step', status: 'in_progress' },
    ]
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are helpful.\n\n---\n\n## Active plan (pinned)\n- [pending] Old step',
      },
      { role: 'user', content: 'Do the refactor' },
      { role: 'assistant', content: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'file contents' }] },
      { role: 'assistant', content: 'Step one done.' },
      { role: 'user', content: 'continue' },
    ]

    compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1, fillRatio: 0.01 })

    const sys = at(messages, 0)
    const sysText = 'content' in sys && typeof sys.content === 'string' ? sys.content : ''
    assert.match(sysText, /Freshly planned step/, 'the pin tracks the current todos')
    assert.equal(sysText.match(/Active plan/g)?.length, 1, 'exactly one plan block, not stacked')
  })

  it('still compacts once the conversation is genuinely under pressure', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Next step', status: 'in_progress' }]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      { role: 'assistant', content: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'file contents' }] },
      { role: 'assistant', content: 'Step one done.' },
      { role: 'user', content: 'continue' },
    ]
    const beforeLen = messages.length

    const changed = compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1, fillRatio: 0.9 })

    assert.equal(changed, true)
    assert.ok(messages.length < beforeLen)
  })

  it('compacts unconditionally when no fill ratio is supplied', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Next step', status: 'in_progress' }]
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Do the refactor' },
      { role: 'assistant', content: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
      { role: 'tool', toolResults: [{ toolCallId: 'tc1', result: 'file contents' }] },
      { role: 'assistant', content: 'Step one done.' },
      { role: 'user', content: 'continue' },
    ]

    assert.equal(compactAtTodoBoundary(messages, todos, { keepRecentPairs: 1 }), true)
  })
})
