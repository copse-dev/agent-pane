import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@shared/types'
import {
  FINAL_REPLY_CACHE_SIZE,
  FINAL_REPLY_MAX_CHARS,
  createFinalReplyCache,
  finalReplyText,
  type FinalReplyRequest,
} from './activity-final-reply.ts'

function message(role: Message['role'], content: string): Message {
  return { id: `${role}-${content.slice(0, 8)}`, role, content, toolCalls: [], createdAt: 1 }
}

function request(key: string, messages: readonly Message[] | null = null): FinalReplyRequest {
  return { key, projectId: 'p1', threadId: key, messages }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('finalReplyText', () => {
  it('returns the last assistant prose of the latest turn, skipping empty tool steps', () => {
    const messages = [
      message('user', 'first ask'),
      message('assistant', 'old reply'),
      message('user', 'second ask'),
      message('assistant', 'Working on it'),
      message('assistant', '  Shipped the **fix**.  '),
      message('assistant', ' '),
    ]
    assert.equal(finalReplyText(messages), 'Shipped the **fix**.')
  })

  it("never passes an earlier turn's reply off as the latest one", () => {
    const messages = [message('assistant', 'old reply'), message('user', 'new ask')]
    assert.equal(finalReplyText(messages), null)
    assert.equal(finalReplyText([]), null)
  })

  it('looks past a trailing error to the reply before it', () => {
    const messages = [
      message('user', 'ask'),
      message('assistant', 'partial answer'),
      message('error', 'boom'),
    ]
    assert.equal(finalReplyText(messages), 'partial answer')
  })

  it('cuts a very long reply with an ellipsis', () => {
    const text = finalReplyText([message('assistant', 'x'.repeat(FINAL_REPLY_MAX_CHARS + 50))])
    assert.ok(text)
    assert.equal(text.length, FINAL_REPLY_MAX_CHARS + 1)
    assert.ok(text.endsWith('…'))
  })
})

describe('createFinalReplyCache', () => {
  it('uses a transcript the renderer already holds without loading', () => {
    const get = createFinalReplyCache(
      () => assert.fail('should not load'),
      () => {},
    )
    assert.deepEqual(get(request('a', [message('assistant', 'hi')])), {
      state: 'ready',
      text: 'hi',
    })
  })

  it('loads once, reports loading, then serves the reply and asks for a redraw', async () => {
    const loads: string[] = []
    let redraws = 0
    const get = createFinalReplyCache(
      (_projectId, threadId) => {
        loads.push(threadId)
        return Promise.resolve([message('assistant', 'done')])
      },
      () => {
        redraws++
      },
    )
    assert.deepEqual(get(request('a')), { state: 'loading' })
    assert.deepEqual(get(request('a')), { state: 'loading' })
    await flush()
    assert.deepEqual(get(request('a')), { state: 'ready', text: 'done' })
    assert.deepEqual(loads, ['a'])
    assert.equal(redraws, 1)
  })

  it('settles a failed load as no reply', async () => {
    const get = createFinalReplyCache(
      () => Promise.reject(new Error('gone')),
      () => {},
    )
    get(request('a'))
    await flush()
    assert.deepEqual(get(request('a')), { state: 'ready', text: null })
  })

  it('forgets the oldest replies past its size', async () => {
    const loads: string[] = []
    const get = createFinalReplyCache(
      (_projectId, threadId) => {
        loads.push(threadId)
        return Promise.resolve([])
      },
      () => {},
    )
    for (let index = 0; index <= FINAL_REPLY_CACHE_SIZE; index++) get(request(`t${String(index)}`))
    await flush()
    get(request(`t${String(FINAL_REPLY_CACHE_SIZE)}`))
    get(request('t0'))
    assert.equal(loads.length, FINAL_REPLY_CACHE_SIZE + 2)
    assert.equal(loads.at(-1), 't0')
  })
})
