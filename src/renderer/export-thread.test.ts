import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

  it('serializes cache usage, subagent usage, and subagent message timestamps', () => {
    const t = thread([
      {
        id: 'message-1',
        role: 'assistant',
        content: '',
        createdAt: 2,
        toolCalls: [
          {
            id: 'tc-explore',
            name: 'explore',
            args: { query: 'find pages' },
            status: 'done',
            result: 'done',
            subagent: {
              id: 'sub-1',
              kind: 'explore',
              status: 'done',
              prompt: 'find pages',
              summary: 'summary',
              usage: { inputTokens: 5000, outputTokens: 120, cacheReadTokens: 4200 },
              messages: [
                { id: 'sm-1', role: 'assistant', content: 'reading', toolCalls: [], createdAt: 99 },
              ],
            },
          },
        ],
      },
    ])
    t.usage = {
      inputTokens: 10000,
      outputTokens: 200,
      cacheReadTokens: 8000,
      cacheCreationTokens: 500,
    }

    const [header, message] = threadToJsonl(t).trimEnd().split('\n')
    const headerObj = JSON.parse(header!)
    const msgObj = JSON.parse(message!)

    assert.equal(headerObj.usage.cacheReadTokens, 8000)
    assert.equal(headerObj.usage.cacheCreationTokens, 500)
    assert.equal(msgObj.toolCalls[0].subagent.usage.cacheReadTokens, 4200)
    assert.equal(msgObj.toolCalls[0].subagent.messages[0].createdAt, 99)
  })
})
