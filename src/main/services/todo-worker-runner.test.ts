import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runTodoWorker } from './todo-worker-runner.ts'
import { ToolRegistry } from './tool-registry.ts'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { TodoItem } from '@shared/types/todo.ts'

function capturingProvider(captured: LLMMessage[][]): LLMProvider {
  return {
    async *stream(messages: LLMMessage[]): AsyncIterable<ProviderStreamChunk> {
      captured.push(messages)
      yield { type: 'text', text: 'Worker summary.' }
      yield { type: 'done' }
    },
  }
}

function userMessageText(messages: LLMMessage[]): string {
  const message = messages.find((m) => m.role === 'user')
  assert.ok(message, 'expected a user message')
  if (typeof message.content !== 'string') {
    throw new Error('expected plain string content')
  }
  return message.content
}

describe('runTodoWorker briefing', () => {
  it('includes the parent goal, sibling plan, and prior summaries instead of just the bare item', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = {
      id: '2',
      content: 'Add category auto-classification service (mirror complexity)',
      status: 'in_progress',
    }
    const allTodos: TodoItem[] = [
      {
        id: '1',
        content: 'Add RoadmapCategory vocabulary to src/shared/roadmap/complexity.ts',
        status: 'completed',
      },
      item,
    ]
    const priorSummaries = new Map([
      ['1', 'Added RoadmapCategory enum + parser to src/shared/roadmap/complexity.ts'],
    ])

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      parentGoal: 'Classify roadmap items into bug/feature/project',
      allTodos,
      priorSummaries,
    })

    const text = userMessageText(captured[0] ?? [])
    assert.match(text, /Classify roadmap items into bug\/feature\/project/)
    assert.match(text, /Add RoadmapCategory vocabulary to src\/shared\/roadmap\/complexity\.ts/)
    assert.match(
      text,
      /Added RoadmapCategory enum \+ parser to src\/shared\/roadmap\/complexity\.ts/,
    )
    assert.match(text, /Add category auto-classification service \(mirror complexity\)/)
  })

  it('does not surface a sibling summary the worker has not produced yet', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = { id: '2', content: 'Second step', status: 'in_progress' }
    const allTodos: TodoItem[] = [{ id: '1', content: 'First step', status: 'pending' }, item]

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      allTodos,
      priorSummaries: new Map(),
    })

    const text = userMessageText(captured[0] ?? [])
    assert.match(text, /First step/)
    assert.doesNotMatch(text, /already found or did/)
  })

  it('falls back to just the item when no briefing context is given', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = { id: '1', content: 'Do the thing', status: 'in_progress' }

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
    })

    const text = userMessageText(captured[0] ?? [])
    assert.equal(
      text,
      'Your assigned todo item:\nDo the thing\n\nComplete this item and summarize what you did.',
    )
  })
})
