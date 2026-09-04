import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isHumanUserPrompt, lastHumanPromptAt, sortThreadsNewestFirst } from './thread-sort.ts'
import type { Message, Thread } from './thread-types.ts'

function message(overrides: Partial<Message> & Pick<Message, 'createdAt'>): Message {
  return {
    id: `m${String(overrides.createdAt)}`,
    role: 'user',
    content: '',
    toolCalls: [],
    ...overrides,
  }
}

function thread(overrides: Partial<Thread> & Pick<Thread, 'id' | 'createdAt'>): Thread {
  return {
    title: 'T',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    updatedAt: overrides.createdAt,
    ...overrides,
  }
}

const HOOK_ORIGIN = { kind: 'hook', hookId: 'h1', event: 'stop' } as const

describe('isHumanUserPrompt', () => {
  it('counts a plain user message', () => {
    assert.equal(isHumanUserPrompt(message({ createdAt: 1 })), true)
  })

  it('rejects assistant and error messages', () => {
    assert.equal(isHumanUserPrompt(message({ createdAt: 1, role: 'assistant' })), false)
    assert.equal(isHumanUserPrompt(message({ createdAt: 1, role: 'error' })), false)
  })

  it('rejects hook and machine continuations', () => {
    const hook = message({ createdAt: 1, origin: HOOK_ORIGIN })
    const machine = message({ createdAt: 1, origin: { kind: 'machine', operationId: 'op1' } })
    assert.equal(isHumanUserPrompt(hook), false)
    assert.equal(isHumanUserPrompt(machine), false)
  })

  it('counts a hook message a human rewrote before it dispatched', () => {
    const edited = message({ createdAt: 1, origin: HOOK_ORIGIN, editedByUser: true })
    assert.equal(isHumanUserPrompt(edited), true)
  })
})

describe('lastHumanPromptAt', () => {
  it('prefers the persisted metadata over the transcript', () => {
    const t = thread({
      id: 'a',
      createdAt: 1,
      lastPromptAt: 500,
      messages: [message({ createdAt: 300 })],
    })
    assert.equal(lastHumanPromptAt(t), 500)
  })

  it('falls back to the last human prompt in a loaded transcript', () => {
    const t = thread({
      id: 'a',
      createdAt: 1,
      messages: [
        message({ createdAt: 10 }),
        message({ createdAt: 20 }),
        message({ createdAt: 30, role: 'assistant' }),
        message({ createdAt: 40, origin: { kind: 'machine', operationId: 'op1' } }),
      ],
    })
    assert.equal(lastHumanPromptAt(t), 20)
  })

  it('is undefined when nobody has prompted the thread', () => {
    assert.equal(lastHumanPromptAt(thread({ id: 'a', createdAt: 1 })), undefined)
    assert.equal(
      lastHumanPromptAt(
        thread({ id: 'a', createdAt: 1, messages: [message({ createdAt: 9, role: 'assistant' })] }),
      ),
      undefined,
    )
  })
})

describe('sortThreadsNewestFirst', () => {
  const ids = (threads: Thread[]): string[] => threads.map((t) => t.id)

  it('orders by last prompt, not by creation', () => {
    const oldest = thread({ id: 'old', createdAt: 1, lastPromptAt: 900 })
    const newest = thread({ id: 'new', createdAt: 100, lastPromptAt: 200 })
    assert.deepEqual(ids(sortThreadsNewestFirst([newest, oldest])), ['old', 'new'])
  })

  it('sorts a never-prompted thread on its creation time', () => {
    const blank = thread({ id: 'blank', createdAt: 500 })
    const prompted = thread({ id: 'prompted', createdAt: 1, lastPromptAt: 400 })
    assert.deepEqual(ids(sortThreadsNewestFirst([prompted, blank])), ['blank', 'prompted'])
  })

  it('mixes threads that carry the metadata with legacy ones that do not', () => {
    const legacy = thread({
      id: 'legacy',
      createdAt: 1,
      messages: [message({ createdAt: 700 })],
    })
    const recorded = thread({ id: 'recorded', createdAt: 2, lastPromptAt: 600 })
    assert.deepEqual(ids(sortThreadsNewestFirst([recorded, legacy])), ['legacy', 'recorded'])
  })

  it('breaks ties on creation time and does not mutate its input', () => {
    const input = [
      thread({ id: 'a', createdAt: 1, lastPromptAt: 100 }),
      thread({ id: 'b', createdAt: 2, lastPromptAt: 100 }),
    ]
    assert.deepEqual(ids(sortThreadsNewestFirst(input)), ['b', 'a'])
    assert.deepEqual(ids(input), ['a', 'b'])
  })
})
