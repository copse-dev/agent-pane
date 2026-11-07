import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import type { PromptSearchResult } from '@copse/thread-store/prompt-search.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createThreadFilter, filterText, residentRequestMatches } from './thread-filter.ts'

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    messagesLoaded: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}
function request(content: string, extra: Partial<Message> = {}): Message {
  return { id: content, role: 'user', content, toolCalls: [], createdAt: 1, ...extra }
}

describe('thread content filter', () => {
  it('uses one ID-only search without loading transcripts and filters stale/foreign IDs', async () => {
    const threads = [thread('saved'), thread('archived', { archivedAt: 1 }), thread('needle title')]
    const store = createStore({ activeProjectId: 'open', threads })
    const api = createFakeApi()
    const calls: string[] = []
    api.threads.loadMessages = async (): Promise<Message[]> => {
      assert.fail('search must not hydrate transcripts')
    }
    api.threads.searchRequests = async (project, query): Promise<PromptSearchResult> => {
      calls.push(project + '/' + query)
      return { matches: ['saved', 'archived', 'foreign'], incomplete: false }
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    assert.equal(filter.waiting, true)
    assert.equal(filter.pending, false)
    assert.deepEqual(calls, [])
    await delay(250)
    assert.deepEqual(calls, ['open/needle'])
    assert.deepEqual([...filter.matches], ['saved'])
    assert.equal(filter.pending, false)
    assert.equal(store.getState().threads, threads)
    filter.cancel()
  })

  it('keeps unsaved human text authoritative over the saved index', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [
        thread('assistant', {
          messagesLoaded: true,
          messages: [request('needle', { role: 'assistant' })],
        }),
        thread('machine', {
          messagesLoaded: true,
          messages: [request('needle', { origin: { kind: 'machine', operationId: 'job' } })],
        }),
        thread('human', { messagesLoaded: true, messages: [request('needle')] }),
        thread('edited-hook', {
          messagesLoaded: true,
          messages: [
            request('needle', {
              origin: { kind: 'machine', operationId: 'job' },
              editedByUser: true,
            }),
          ],
        }),
        thread('live-tail', { messages: [request('needle')] }),
        thread('edited-away', { messagesLoaded: true, messages: [request('other words')] }),
      ],
    })
    const api = createFakeApi()
    api.threads.searchRequests = async (): Promise<PromptSearchResult> => ({
      matches: ['edited-away'],
      incomplete: false,
    })
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    await delay(250)
    assert.deepEqual([...filter.matches], ['human', 'edited-hook', 'live-tail'])
    filter.cancel()
  })

  it('debounces typing and discards superseded results without queueing new searches behind them', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [thread('old', { title: 'First work' }), thread('new', { title: 'Second work' })],
    })
    const api = createFakeApi()
    let finish: (result: PromptSearchResult) => void = () => assert.fail('not started')
    const first = new Promise<PromptSearchResult>((resolve) => {
      finish = resolve
    })
    const calls: string[] = []
    let cancels = 0
    api.threads.cancelRequestSearch = async (): Promise<void> => {
      cancels++
    }
    api.threads.searchRequests = async (_project, query): Promise<PromptSearchResult> => {
      calls.push(query)
      return query === 'old' ? first : { matches: ['new'], incomplete: false }
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('ol')
    filter.search('old')
    await delay(250)
    filter.search('new')
    await delay(250)
    assert.deepEqual(calls, ['old', 'new'])
    assert.deepEqual([...filter.matches], ['new'])
    finish({ matches: ['old'], incomplete: true })
    await delay(0)
    assert.deepEqual([...filter.matches], ['new'])
    assert.equal(filter.failed, false)
    assert.ok(cancels >= 3)
    filter.cancel()
  })

  it('ignores results after switching, clearing, or disposal', async () => {
    for (const action of ['workspace', 'clear', 'dispose']) {
      const store = createStore({ activeProjectId: 'open', threads: [thread('saved')] })
      const api = createFakeApi()
      let finish: (result: PromptSearchResult) => void = () => assert.fail('not started')
      api.threads.searchRequests = (): Promise<PromptSearchResult> =>
        new Promise((resolve) => {
          finish = resolve
        })
      const filter = createThreadFilter(store, api, () => {})
      filter.search('needle')
      await delay(250)
      if (action === 'workspace') store.setState({ activeProjectId: 'other' })
      else if (action === 'clear') filter.search('')
      else filter.cancel()
      finish({ matches: ['saved'], incomplete: false })
      await delay(0)
      assert.deepEqual([...filter.matches], [])
      filter.cancel()
    }
  })

  it('reports incomplete/failed queries and recovers on the next search', async () => {
    const store = createStore({ activeProjectId: 'open', threads: [thread('saved')] })
    const api = createFakeApi()
    let fail = true
    api.threads.searchRequests = async (): Promise<PromptSearchResult> => {
      if (fail) throw new Error('worker exited')
      return { matches: ['saved'], incomplete: true }
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('needle')
    await delay(250)
    assert.equal(filter.failed, true)
    assert.equal(filter.pending, false)
    fail = false
    filter.search('needle')
    await delay(250)
    assert.equal(filter.failed, true)
    assert.deepEqual([...filter.matches], ['saved'])
    filter.cancel()
  })

  it('does no saved search for one character or fully resident histories', async () => {
    const store = createStore({
      activeProjectId: 'open',
      threads: [thread('human', { messagesLoaded: true, messages: [request('needle')] })],
    })
    const api = createFakeApi()
    api.threads.searchRequests = async (): Promise<PromptSearchResult> => {
      assert.fail('no disk search needed')
    }
    const filter = createThreadFilter(store, api, () => {})
    filter.search('n')
    assert.equal(filter.waiting, false)
    assert.equal(residentRequestMatches([request('needle')], 'n'), false)
    filter.search('needle')
    await delay(250)
    assert.deepEqual([...filter.matches], ['human'])
    filter.cancel()
    assert.equal(filterText('CAFÉ'), filterText('Cafe\u0301'))
  })
})
