import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createThreadFilter, filterText, residentRequestMatches } from './thread-filter.ts'

function thread(id: string, date: number, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    messagesLoaded: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: date,
    updatedAt: date,
    ...extra,
  }
}

function request(content: string, extra: Partial<Message> = {}): Message {
  return { id: content, role: 'user', content, toolCalls: [], createdAt: 1, ...extra }
}

function deferredMessages(): { promise: Promise<Message[]>; resolve(messages: Message[]): void } {
  let resolve = (_messages: Message[]): void => {
    throw new Error('Promise not initialized')
  }
  const promise = new Promise<Message[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('thread content filter', () => {
  it('scans only the current project, newest human request first, without hydrating threads', async () => {
    const threads = [
      thread('old', 1),
      thread('new', 3),
      thread('recent-request', 2, { lastPromptAt: 4 }),
      thread('needle title', 5),
      thread('archived', 6, { archivedAt: 7 }),
    ]
    const store = createStore({ activeProjectId: 'open', threads })
    const api = createFakeApi()
    const reads: string[] = []
    api.threads.loadMessages = async (projectId, id): Promise<Message[]> => {
      reads.push(`${projectId}/${id}`)
      return [request('a Needle in this request')]
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    assert.deepEqual(reads, [])
    // Debouncing is not searching: no status until a read can actually start.
    assert.equal(filter.waiting, true)
    assert.equal(filter.pending, false)
    await delay(250)
    assert.equal(filter.waiting, false)
    assert.deepEqual(reads, ['open/recent-request', 'open/new', 'open/old'])
    assert.deepEqual([...filter.matches], ['recent-request', 'new', 'old'])
    assert.equal(filter.pending, false)
    assert.equal(store.getState().threads, threads)
    assert.ok(threads.every((t) => t.messages.length === 0 && t.messagesLoaded === false))
    filter.cancel()
  })

  it('matches human text, excluding assistant, tools, and automatic continuations', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [
        thread('assistant', 1, {
          messagesLoaded: true,
          messages: [request('needle', { role: 'assistant' })],
        }),
        thread('machine', 2, {
          messagesLoaded: true,
          messages: [request('needle', { origin: { kind: 'machine', operationId: 'job' } })],
        }),
        thread('human', 3, { messagesLoaded: true, messages: [request('needle')] }),
        thread('live-tail', 4, { messages: [request('needle')] }),
      ],
    })
    const api = createFakeApi()
    api.threads.loadMessages = async (): Promise<Message[]> => {
      assert.fail('already resident requests need no disk read')
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    await delay(250)
    assert.deepEqual([...filter.matches], ['live-tail', 'human'])
    filter.cancel()
  })

  it('cancels stale queries and serializes reads while a transcript is in flight', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [thread('older', 1), thread('newer', 2)],
    })
    const api = createFakeApi()
    const firstRead = deferredMessages()
    const reads: string[] = []
    api.threads.loadMessages = async (_projectId, id): Promise<Message[]> => {
      reads.push(id)
      return reads.length === 1 ? firstRead.promise : [request('new query')]
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('old query')
    await delay(250)
    assert.deepEqual(reads, ['newer'])
    filter.search('new query')
    await delay(250)
    assert.deepEqual(reads, ['newer'])
    firstRead.resolve([request('old query')])
    await delay(0)
    // The superseded read is still indexed, so the new query reuses it.
    assert.deepEqual(reads, ['newer', 'older'])
    assert.deepEqual([...filter.matches], ['older'])
    filter.cancel()
  })

  it('stops after a workspace switch, clear, or disposal', async () => {
    for (const action of ['workspace', 'clear', 'dispose']) {
      const store = createStore({
        activeProjectId: 'open',
        threads: [thread('older', 1), thread('newer', 2)],
      })
      const api = createFakeApi()
      const response = deferredMessages()
      const reads: string[] = []
      api.threads.loadMessages = async (_projectId, id): Promise<Message[]> => {
        reads.push(id)
        return response.promise
      }
      const filter = createThreadFilter(store, api, () => {})
      filter.search('needle')
      await delay(250)
      if (action === 'workspace') store.setState({ activeProjectId: 'elsewhere' })
      else if (action === 'clear') filter.search('')
      else filter.cancel()
      response.resolve([request('needle')])
      await delay(0)
      assert.deepEqual(reads, ['newer'])
      assert.deepEqual([...filter.matches], [])
      filter.cancel()
    }
  })

  it('reports incomplete searches and continues past an unreadable thread', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [thread('older', 1), thread('newer', 2)],
    })
    const api = createFakeApi()
    api.threads.loadMessages = async (_projectId, id): Promise<Message[]> => {
      if (id === 'newer') throw new Error('unreadable')
      return [request('needle')]
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    await delay(250)
    assert.equal(filter.failed, true)
    assert.equal(filter.pending, false)
    assert.deepEqual([...filter.matches], ['older'])
    filter.cancel()
  })

  it('indexes each transcript once and reuses it across queries', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [thread('older', 1), thread('newer', 2)],
    })
    const api = createFakeApi()
    const reads: string[] = []
    api.threads.loadMessages = async (_projectId, id): Promise<Message[]> => {
      reads.push(id)
      return [request(id === 'newer' ? 'I need a Needle' : 'nothing here')]
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('nee')
    await delay(250)
    filter.search('needle')
    await delay(250)
    assert.deepEqual(reads, ['newer', 'older'])
    assert.deepEqual([...filter.matches], ['newer'])
    filter.cancel()
  })

  it('re-reads a transcript once the thread gains a request', async () => {
    const store = createStore({ activeProjectId: 'open', threads: [thread('t', 1)] })
    const api = createFakeApi()
    let content = 'old words'
    const reads: string[] = []
    api.threads.loadMessages = async (_projectId, id): Promise<Message[]> => {
      reads.push(id)
      return [request(content)]
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    await delay(250)
    assert.deepEqual([...filter.matches], [])
    content = 'now a needle'
    store.setState({ threads: [thread('t', 1, { lastPromptAt: 5 })] })
    filter.search('needle')
    await delay(250)
    assert.deepEqual(reads, ['t', 't'])
    assert.deepEqual([...filter.matches], ['t'])
    filter.cancel()
  })

  it('re-reads a transcript saved without a new request', async () => {
    const store = createStore({ activeProjectId: 'open', threads: [thread('t', 1)] })
    const api = createFakeApi()
    let content = 'a needle'
    const reads: string[] = []
    api.threads.loadMessages = async (_projectId, id): Promise<Message[]> => {
      reads.push(id)
      return [request(content)]
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    await delay(250)
    assert.deepEqual([...filter.matches], ['t'])
    // An edit or truncation saves the thread without moving `lastPromptAt`.
    content = 'rewritten'
    store.setState({ threads: [thread('t', 1, { updatedAt: 99 })] })
    filter.search('needle')
    await delay(250)
    assert.deepEqual(reads, ['t', 't'])
    assert.deepEqual([...filter.matches], [])
    filter.cancel()
  })

  it('filters titles only for one-character queries', async () => {
    const store = createStore({ activeProjectId: 'open', threads: [thread('t', 1)] })
    const api = createFakeApi()
    api.threads.loadMessages = async (): Promise<Message[]> => {
      assert.fail('a one-character query must not read transcripts')
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('n')
    assert.equal(filter.waiting, false)
    await delay(250)
    assert.equal(filter.pending, false)
    assert.equal(residentRequestMatches([request('needle')], 'n'), false)
    filter.cancel()
  })

  it('matches composed and decomposed accents alike', async () => {
    const store = createStore({ activeProjectId: 'open', threads: [thread('t', 1)] })
    const api = createFakeApi()
    api.threads.loadMessages = async (): Promise<Message[]> => [request('Fix the Cafe\u0301 menu')]
    const filter = createThreadFilter(store, api, () => {})
    filter.search('caf\u00e9')
    await delay(250)
    assert.deepEqual([...filter.matches], ['t'])
    assert.equal(filterText('CAF\u00c9'), filterText('Cafe\u0301'))
    filter.cancel()
  })

  it('keeps searching after a sidebar update throws', async () => {
    const store = createStore({ activeProjectId: 'open', threads: [thread('t', 1)] })
    const api = createFakeApi()
    api.threads.loadMessages = async (): Promise<Message[]> => [request('needle')]
    let throws = true
    const filter = createThreadFilter(store, api, () => {
      if (throws) throw new Error('render failed')
    })
    filter.search('needle')
    await delay(250)
    assert.equal(filter.pending, false)
    throws = false
    filter.search('needl')
    await delay(250)
    assert.equal(filter.pending, false)
    assert.deepEqual([...filter.matches], ['t'])
    filter.cancel()
  })
})
