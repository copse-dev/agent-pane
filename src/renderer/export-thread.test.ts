import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import type { Thread } from '@shared/types'
import { threadHasExportableContent, threadToJsonl } from './export-thread.ts'

function thread(messages: Thread['messages'] = []): Thread {
  return {
    id: 'thread-1',
    title: 'New Thread',
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('export thread', () => {
  it('does not treat a blank thread as exportable', () => {
    assert.equal(threadHasExportableContent(undefined), false)
    assert.equal(threadHasExportableContent(thread()), false)
  })

  it('treats threads with messages as exportable', () => {
    assert.equal(
      threadHasExportableContent(
        thread([
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            toolCalls: [],
            createdAt: 2,
          },
        ]),
      ),
      true,
    )
  })

  it('exports one JSONL message line per message', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'user',
          content: 'hello',
          toolCalls: [],
          createdAt: 2,
        },
      ]),
    )

    assert.equal(jsonl.trimEnd().split('\n').length, 2)
  })

  it('includes the thread header fields beyond the legacy subset', () => {
    const t = thread()
    t.status = 'error'
    t.todos = [{ id: 'todo-1', content: 'do thing', status: 'pending' }]
    t.review = { status: 'done', summary: 'looks good' }
    t.workingBrief = 'fix the bug'
    t.gitBranch = 'feature/x'
    t.contextSnapshot = {
      contextWindow: 200000,
      conversationBudget: 150000,
      conversationTokens: 1000,
      fillRatio: 0.5,
      updatedAt: 3,
    }
    t.queuePaused = true
    t.draftPrompt = 'unsent'

    const header = JSON.parse(at(threadToJsonl(t).trimEnd().split('\n'), 0)) as Record<
      string,
      unknown
    >
    assert.equal(header['exportVersion'], 3)
    assert.equal(header['status'], 'error')
    assert.deepEqual(header['todos'], t.todos)
    assert.deepEqual(header['review'], t.review)
    assert.equal(header['workingBrief'], 'fix the bug')
    assert.equal(header['gitBranch'], 'feature/x')
    assert.deepEqual(header['contextSnapshot'], t.contextSnapshot)
    assert.equal(header['queuePaused'], true)
    assert.equal(header['draftPrompt'], 'unsent')
  })

  it('infers distinct provider slugs from usage.byModel keys', () => {
    const t = thread()
    t.usage = {
      inputTokens: 1,
      outputTokens: 1,
      byModel: {
        'claude-sonnet-4-6': { inputTokens: 1, outputTokens: 1 },
        'gpt-5': { inputTokens: 0, outputTokens: 0 },
        'lmstudio:qwen': { inputTokens: 0, outputTokens: 0 },
      },
    }

    const header = JSON.parse(at(threadToJsonl(t).trimEnd().split('\n'), 0)) as {
      providers: string[]
    }
    assert.deepEqual([...header.providers].sort(), ['anthropic', 'lmstudio', 'openai'])
  })

  it('exports message commandSummary and full toolCalls (editStats, subagent usage)', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'done',
          commandSummary: 'ran 3 shell commands',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'write_file',
              args: {},
              status: 'done',
              result: 'ok',
              editStats: { additions: 5, deletions: 2 },
              subagent: {
                id: 'sub-1',
                kind: 'explore',
                status: 'done',
                prompt: 'look',
                summary: 'found it',
                messages: [],
                usage: { inputTokens: 10, outputTokens: 4 },
              },
            },
          ],
          createdAt: 2,
        },
      ]),
    )

    const line = JSON.parse(at(jsonl.trimEnd().split('\n'), 1)) as {
      commandSummary: string
      toolCalls: Array<{
        editStats: { additions: number; deletions: number }
        subagent: { usage: { inputTokens: number; outputTokens: number } }
      }>
    }
    assert.equal(line.commandSummary, 'ran 3 shell commands')
    const toolCall = at(line.toolCalls, 0)
    assert.deepEqual(toolCall.editStats, { additions: 5, deletions: 2 })
    assert.deepEqual(toolCall.subagent.usage, { inputTokens: 10, outputTokens: 4 })
  })

  it('exports assistant reasoning when present', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'answer',
          reasoning: 'thinking step by step',
          toolCalls: [],
          createdAt: 2,
        },
      ]),
    )

    const line = JSON.parse(at(jsonl.trimEnd().split('\n'), 1)) as { reasoning?: string }
    assert.equal(line.reasoning, 'thinking step by step')
  })
})
