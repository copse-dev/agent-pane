import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RemoteView } from '@shared/remote-interface.ts'
import type { MobileCompanionState } from '@shared/types/mobile-companion.ts'
import { attachRemotePublisher } from './remote-publisher.ts'
import { createThread } from '@shared/store/thread-helpers.ts'

function setup(): {
  store: AppStore
  views: RemoteView[]
  events: { state?: (state: MobileCompanionState) => void }
  api: ApiClient
  base: ApiClient
} {
  const base = createFakeApi()
  const views: RemoteView[] = []
  const events: { state?: (state: MobileCompanionState) => void } = {}
  const api: ApiClient = {
    ...base,
    remote: {
      publish: async (view) => {
        views.push(view)
      },
    },
    mobile: {
      ...base.mobile,
      onStateChanged: (handler) => {
        events.state = handler
        return () => {
          delete events.state
        }
      },
    },
  }
  const store = createStore({ activeProjectId: 'p', threads: [] })
  return { store, views, events, api, base }
}

describe('desktop remote publisher', () => {
  it('keeps background output and the final state after the desktop switches project', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { store, views, events, api, base } = setup()
    const threadId = createThread(store)
    createThread(store)
    const live = store.getState().threads.find((thread) => thread.id === threadId)
    assert.ok(live)
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    await Promise.resolve()
    context.mock.timers.tick(150)
    store.setState({
      activeProjectId: 'other',
      threads: [],
      backgroundThreads: [{ projectId: 'p', thread: { ...live, status: 'running' } }],
    })
    store.emit('threads_changed')
    context.mock.timers.tick(150)
    assert.equal(views.filter((view) => view.projectId === 'p').at(-1)?.threads.length, 2)
    store.setState({
      backgroundThreads: [
        { projectId: 'p', thread: { ...live, title: 'Final output', status: 'idle' } },
      ],
    })
    store.emit('thread_status_changed', threadId, 'idle')
    store.setState({ backgroundThreads: [] })
    context.mock.timers.tick(150)
    const final = views
      .filter((view) => view.projectId === 'p')
      .at(-1)
      ?.threads.find((thread) => thread.id === threadId)
    assert.ok(final)
    assert.equal(final.status, 'idle')
    assert.equal(final.title, 'Final output')
    dispose()
  })

  it('does no snapshot work while Mobile Companion is disabled', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { store, views, api } = setup()
    const dispose = attachRemotePublisher(store, api)
    await Promise.resolve()
    store.emit('threads_changed')
    context.mock.timers.tick(1000)
    assert.deepEqual(views, [])
    dispose()
  })

  it('coalesces updates only while the companion is running and cancels on disable', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { store, views, events, api, base } = setup()
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    await Promise.resolve()
    store.emit('threads_changed')
    store.emit('threads_changed')
    context.mock.timers.tick(150)
    assert.equal(views.length, 1)
    assert.equal(views[0]?.projectId, 'p')
    store.emit('threads_changed')
    events.state?.({ ...state, enabled: false, running: false })
    context.mock.timers.tick(1000)
    assert.equal(views.length, 1)
    dispose()
  })

  it('does not publish after disposal, including late startup availability', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { store, views, events, api, base } = setup()
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    dispose()
    await Promise.resolve()
    store.emit('threads_changed')
    context.mock.timers.tick(1000)
    assert.equal(views.length, 0)
  })
})
