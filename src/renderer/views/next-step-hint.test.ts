import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountNextStepHint } from './next-step-hint.ts'

interface Harness {
  api: ApiClient
  fetches: string[]
}

function fakeApi(options: { enabled: boolean; hint: string | null }): Harness {
  const base = createFakeApi()
  const fetches: string[] = []
  const api: ApiClient = {
    ...base,
    settings: {
      ...base['settings'],
      get: (key: string) =>
        Promise.resolve(key === 'nextStepSuggestionEnabled' ? options.enabled : undefined),
    },
    agent: {
      ...base['agent'],
      suggestNextStep: (contextJson: string) => {
        fetches.push(contextJson)
        return Promise.resolve(options.hint)
      },
    },
  }
  return { api, fetches }
}

function storeWithFinishedTurn(): { store: ReturnType<typeof createStore>; threadId: string } {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'fix the parser bug')
  addMessage(store, threadId, 'assistant', 'Fixed it in parser.ts.')
  return { store, threadId }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('next-step hint controller', () => {
  it('fetches once per finished turn and exposes the hint for the active thread', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, fetches } = fakeApi({ enabled: true, hint: 'Run the tests' })
    let changes = 0
    const mount = mountNextStepHint(store, api, () => {
      changes++
    })

    store.emit('thread_status_changed', threadId, 'idle')
    await flush()

    assert.equal(mount.current(), 'Run the tests')
    assert.equal(fetches.length, 1)
    assert.equal(changes, 1)

    // Same turn going idle again (e.g. queue drain) must not re-bill.
    store.emit('thread_status_changed', threadId, 'idle')
    await flush()
    assert.equal(fetches.length, 1)

    mount.destroy()
  })

  it('does not call the model when the experimental setting is off', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, fetches } = fakeApi({ enabled: false, hint: 'Run the tests' })
    const mount = mountNextStepHint(store, api, () => {})

    store.emit('thread_status_changed', threadId, 'idle')
    await flush()

    assert.equal(mount.current(), null)
    assert.equal(fetches.length, 0)
    mount.destroy()
  })

  it('drops the hint the moment the thread starts running again', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api } = fakeApi({ enabled: true, hint: 'Run the tests' })
    const mount = mountNextStepHint(store, api, () => {})

    store.emit('thread_status_changed', threadId, 'idle')
    await flush()
    assert.equal(mount.current(), 'Run the tests')

    store.emit('thread_status_changed', threadId, 'running')
    assert.equal(mount.current(), null)
    mount.destroy()
  })

  it('clear() spends the hint for good — no refetch on threads_changed', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, fetches } = fakeApi({ enabled: true, hint: 'Run the tests' })
    const mount = mountNextStepHint(store, api, () => {})

    store.emit('thread_status_changed', threadId, 'idle')
    await flush()
    assert.equal(mount.current(), 'Run the tests')

    mount.clear()
    assert.equal(mount.current(), null)

    store.emit('threads_changed')
    await flush()
    assert.equal(fetches.length, 1)
    assert.equal(mount.current(), null)
    mount.destroy()
  })

  it('fetches lazily when switching to an idle thread restored with a finished turn', async () => {
    const { store, threadId } = storeWithFinishedTurn()
    const { api, fetches } = fakeApi({ enabled: true, hint: 'Run the tests' })
    const mount = mountNextStepHint(store, api, () => {})

    // No idle transition was ever observed (e.g. app reload); the switch event
    // is the first sight of this thread.
    store.emit('threads_changed')
    await flush()

    assert.equal(fetches.length, 1)
    assert.equal(mount.current(), 'Run the tests')

    // The other thread has no finished exchange, so nothing is offered there.
    const emptyThreadId = createThread(store)
    store.setState({ activeThreadId: emptyThreadId })
    store.emit('threads_changed')
    await flush()
    assert.equal(mount.current(), null)

    // Switching back shows the cached hint without a second call.
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
    await flush()
    assert.equal(fetches.length, 1)
    assert.equal(mount.current(), 'Run the tests')
    mount.destroy()
  })
})
