import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RemoteView, RemoteWatchedThread } from '@shared/remote-interface.ts'
import type { MobileCompanionState } from '@shared/types/mobile-companion.ts'
import type { Message } from '@shared/types'
import { attachRemotePublisher } from './remote-publisher.ts'
import { createThread } from '@shared/store/thread-helpers.ts'

interface Events {
  state?: (state: MobileCompanionState) => void
  watched?: (watched: RemoteWatchedThread[]) => void
}

function setup(
  options: {
    initiallyWatched?: RemoteWatchedThread[]
    publish?: (view: RemoteView) => Promise<void>
  } = {},
): {
  store: AppStore
  views: RemoteView[]
  events: Events
  api: ApiClient
  base: ApiClient
} {
  const base = createFakeApi()
  const views: RemoteView[] = []
  const events: Events = {}
  const api: ApiClient = {
    ...base,
    remote: {
      publish:
        options.publish ??
        (async (view): Promise<void> => {
          views.push(view)
        }),
      watched: (): Promise<RemoteWatchedThread[]> =>
        Promise.resolve(options.initiallyWatched ?? []),
      onWatchedChanged: (handler) => {
        events.watched = handler
        return () => {
          delete events.watched
        }
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

/** Give these threads a loaded transcript, as the desktop holds one it has opened. */
function loadTranscripts(store: AppStore, ids: readonly string[]): void {
  store.setState({
    threads: store.getState().threads.map((thread) => {
      if (!ids.includes(thread.id)) return thread
      const message: Message = {
        id: `${thread.id}-m`,
        role: 'user',
        content: 'a long transcript',
        createdAt: 1,
        toolCalls: [],
      }
      return { ...thread, messages: [message], messagesLoaded: true }
    }),
  })
}

/** Each thread of a published view as [transcript length, messagesLoaded], by id. */
function transcripts(view: RemoteView | undefined): Record<string, [number, boolean | undefined]> {
  return Object.fromEntries(
    (view?.threads ?? []).map((thread) => [
      thread.id,
      [thread.messages.length, thread.messagesLoaded],
    ]),
  )
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
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

  it('publishes a transcript only for a thread a client is watching (#4445)', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { store, views, events, api, base } = setup()
    const watchedId = createThread(store)
    const otherId = createThread(store)
    const blankId = createThread(store)
    loadTranscripts(store, [watchedId, otherId])
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    await settle()
    context.mock.timers.tick(150)
    // Nobody is watching: rows only, in the shape of a thread the desktop has not opened.
    assert.deepEqual(transcripts(views.at(-1)), {
      [watchedId]: [0, false],
      [otherId]: [0, false],
      [blankId]: [0, undefined],
    })

    events.watched?.([{ projectId: 'p', threadId: watchedId }])
    context.mock.timers.tick(150)
    assert.deepEqual(transcripts(views.at(-1)), {
      [watchedId]: [1, true],
      [otherId]: [0, false],
      [blankId]: [0, undefined],
    })

    events.watched?.([])
    context.mock.timers.tick(150)
    assert.deepEqual(transcripts(views.at(-1))[watchedId], [0, false])
    dispose()
  })

  it('publishes the transcript of a thread already watched when it starts', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const initiallyWatched: RemoteWatchedThread[] = []
    const { store, views, events, api, base } = setup({ initiallyWatched })
    const watchedId = createThread(store)
    loadTranscripts(store, [watchedId])
    initiallyWatched.push({ projectId: 'p', threadId: watchedId })
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    await settle()
    context.mock.timers.tick(150)
    assert.deepEqual(transcripts(views.at(-1))[watchedId], [1, true])
    dispose()
  })

  it('sends a project again only when it changed', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { store, views, events, api, base } = setup()
    const id = createThread(store)
    loadTranscripts(store, [id])
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    await settle()
    context.mock.timers.tick(150)
    assert.equal(views.length, 1)

    // Events without a change in this project send nothing.
    for (let index = 0; index < 5; index++) {
      store.emit('message_token', `${id}-m`, 'x')
      context.mock.timers.tick(150)
    }
    assert.equal(views.length, 1)

    store.setState({
      threads: store
        .getState()
        .threads.map((thread) => (thread.id === id ? { ...thread, title: 'Renamed' } : thread)),
    })
    store.emit('threads_changed')
    context.mock.timers.tick(150)
    assert.equal(views.length, 2)
    assert.equal(views.at(-1)?.threads[0]?.title, 'Renamed')

    // A project the desktop has left is not sent again for activity elsewhere.
    store.setState({ activeProjectId: 'other', threads: [] })
    store.emit('threads_changed')
    context.mock.timers.tick(150)
    for (let index = 0; index < 5; index++) {
      store.setState({ threads: [...store.getState().threads] })
      store.emit('message_token', 'elsewhere', 'x')
      context.mock.timers.tick(150)
    }
    assert.equal(views.filter((view) => view.projectId === 'p').length, 2)
    assert.ok(views.some((view) => view.projectId === 'other'))
    dispose()
  })

  it('sends a project again after its publish failed', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const delivered: RemoteView[] = []
    let failures = 1
    const { store, events, api, base } = setup({
      publish: async (view) => {
        if (failures > 0) {
          failures--
          throw new Error('Too large to send in one request')
        }
        delivered.push(view)
      },
    })
    createThread(store)
    const state = await base.mobile.getState()
    const dispose = attachRemotePublisher(store, api)
    events.state?.({ ...state, enabled: true, running: true })
    await settle()
    context.mock.timers.tick(150)
    await settle()
    assert.equal(delivered.length, 0)
    store.emit('message_token', 'any', 'x')
    context.mock.timers.tick(150)
    assert.equal(delivered.length, 1)
    dispose()
  })
})
