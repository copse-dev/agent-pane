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
          createdAt: 2,
        },
      ]),
    )

    assert.equal(jsonl.trimEnd().split('\n').length, 2)
  })
})
