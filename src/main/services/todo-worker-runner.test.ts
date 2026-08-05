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
  it('includes the parent goal and prior completed summaries, not a list of other work', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = {
      id: '2',
      content: 'Add category auto-classification service (mirror complexity)',
      status: 'in_progress',
    }
    const priorSummaries = new Map([
      [
        '1',
        {
          content: 'Add RoadmapCategory vocabulary to src/shared/roadmap/complexity.ts',
          summary: 'Added RoadmapCategory enum + parser to src/shared/roadmap/complexity.ts',
        },
      ],
    ])

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      parentGoal: 'Classify roadmap items into bug/feature/project',
      priorSummaries,
    })

    const text = userMessageText(captured[0] ?? [])
    assert.match(text, /Classify roadmap items into bug\/feature\/project/)
    assert.match(text, /Add RoadmapCategory vocabulary to src\/shared\/roadmap\/complexity\.ts/)
    assert.match(
      text,
      /Added RoadmapCategory enum \+ parser to src\/shared\/roadmap\/complexity\.ts/,
    )
    assert.match(text, /it is not your task/)
    assert.match(text, /Add category auto-classification service \(mirror complexity\)/)
  })

  it('drops the oldest prior summaries once the background budget is exceeded', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = { id: '99', content: 'Final step', status: 'in_progress' }
    const priorSummaries = new Map([
      ['1', { content: 'Oldest step', summary: 'v'.repeat(1_500) }],
      ['2', { content: 'Second step', summary: 'w'.repeat(1_500) }],
      ['3', { content: 'Third step', summary: 'x'.repeat(1_500) }],
      ['4', { content: 'Newest step', summary: 'y'.repeat(1_500) }],
    ])

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      priorSummaries,
    })

    const text = userMessageText(captured[0] ?? [])
    assert.match(text, /Newest step/)
    assert.doesNotMatch(text, /Oldest step/)
  })

  it('truncates one oversized summary rather than letting it evict every other step', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = { id: '99', content: 'Final step', status: 'in_progress' }
    // A worker's summary is uncapped free-form text, so the newest step alone can
    // exceed the whole background budget. It must not take the others down with it.
    const priorSummaries = new Map([
      ['1', { content: 'Oldest step', summary: 'Built the parser in src/parse.ts' }],
      ['2', { content: 'Newest step', summary: 'z'.repeat(9_000) }],
    ])

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      priorSummaries,
    })

    const text = userMessageText(captured[0] ?? [])
    assert.match(text, /Newest step/)
    assert.match(text, /Oldest step/)
    assert.match(text, /Built the parser in src\/parse\.ts/)
    assert.ok(!text.includes('z'.repeat(1_000)), 'oversized summary should be truncated')
  })

  it('omits the background section entirely when there is nothing to reuse', async () => {
    const captured: LLMMessage[][] = []
    const item: TodoItem = { id: '1', content: 'Do the thing', status: 'in_progress' }

    await runTodoWorker({
      item,
      provider: capturingProvider(captured),
      registry: new ToolRegistry(),
      contextWindow: 100_000,
      toolSchemaReserve: 0,
      signal: new AbortController().signal,
      priorSummaries: new Map(),
    })

    const text = userMessageText(captured[0] ?? [])
    assert.doesNotMatch(text, /Background/)
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
