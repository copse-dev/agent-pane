import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountThreadRoadmapOrigin } from './thread-roadmap-origin.ts'

/** Flush enough microtasks for the chip's async `findByThread` lookup to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function makeApi(originByThread: Record<string, { id: string; title: string }>): {
  api: ApiClient
  calls: string[]
  fireChanged: () => void
} {
  const calls: string[] = []
  let changedHandler: (() => void) | null = null
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    roadmap: {
      ...base.roadmap,
      findByThread: async (threadId: string) => {
        calls.push(threadId)
        return originByThread[threadId] ?? null
      },
      onChanged: (handler: () => void): (() => void) => {
        changedHandler = handler
        return () => {
          changedHandler = null
        }
      },
    },
  }
  return { api, calls, fireChanged: () => changedHandler?.() }
}

describe('thread roadmap origin chip', () => {
  it('stays hidden for a thread with no roadmap origin', async () => {
    const store = createStore({ activeThreadId: 'thread-1' })
    const { api } = makeApi({})
    const { element, destroy } = mountThreadRoadmapOrigin(store, api)
    try {
      await flush()
      assert.equal(element.hidden, true)
    } finally {
      destroy()
    }
  })

  it('stays hidden with no active thread, without querying the api', async () => {
    const store = createStore({ activeThreadId: null })
    const { api, calls } = makeApi({})
    const { element, destroy } = mountThreadRoadmapOrigin(store, api)
    try {
      await flush()
      assert.equal(element.hidden, true)
      assert.deepEqual(calls, [])
    } finally {
      destroy()
    }
  })

  it('shows the item title for a thread tracked on a roadmap item', async () => {
    const store = createStore({ activeThreadId: 'thread-1' })
    const { api } = makeApi({
      'thread-1': { id: 'item-a', title: 'Refactor the settings dialog' },
    })
    const { element, destroy } = mountThreadRoadmapOrigin(store, api)
    try {
      await flush()
      assert.equal(element.hidden, false)
      assert.equal(
        element.querySelector('.thread-roadmap-origin-title')?.textContent,
        'Refactor the settings dialog',
      )
    } finally {
      destroy()
    }
  })

  it('clicking the chip opens the roadmap pane with the item selected', async () => {
    const store = createStore({ activeThreadId: 'thread-1' })
    const { api } = makeApi({ 'thread-1': { id: 'item-a', title: 'Port e2e specs' } })
    const revealed: string[] = []
    store.on('roadmap_reveal', (id) => revealed.push(id))
    const { element, destroy } = mountThreadRoadmapOrigin(store, api)
    try {
      await flush()
      element.click()
      assert.equal(store.getState().filesPaneOpen, true)
      assert.equal(store.getState().rightPanelMode, 'roadmap')
      assert.deepEqual(revealed, ['item-a'])
    } finally {
      destroy()
    }
  })

  it('picks up the stamp once it lands after the thread already exists', async () => {
    // "Start thread" creates the thread (threads_changed fires here, before
    // the item's `thread` field is stamped) and only later stamps the item —
    // the exact race register-handlers.ts's roadmap:set-thread broadcasts
    // roadmap:changed for.
    const origin: Record<string, { id: string; title: string }> = {}
    const store = createStore({ activeThreadId: null })
    const { api, fireChanged } = makeApi(origin)
    const { element, destroy } = mountThreadRoadmapOrigin(store, api)
    try {
      store.setState({ activeThreadId: 'thread-1' })
      store.emit('threads_changed')
      await flush()
      assert.equal(element.hidden, true, 'not stamped yet')

      origin['thread-1'] = { id: 'item-a', title: 'Ship the roadmap reopen feature' }
      fireChanged()
      await flush()
      assert.equal(element.hidden, false)
      assert.equal(
        element.querySelector('.thread-roadmap-origin-title')?.textContent,
        'Ship the roadmap reopen feature',
      )
    } finally {
      destroy()
    }
  })

  it('re-syncs on thread switch: hides once the new thread has no origin', async () => {
    const store = createStore({ activeThreadId: 'thread-1' })
    const { api } = makeApi({ 'thread-1': { id: 'item-a', title: 'Has an origin' } })
    const { element, destroy } = mountThreadRoadmapOrigin(store, api)
    try {
      await flush()
      assert.equal(element.hidden, false)

      store.setState({ activeThreadId: 'thread-2' })
      store.emit('threads_changed')
      await flush()
      assert.equal(element.hidden, true)
    } finally {
      destroy()
    }
  })
})
