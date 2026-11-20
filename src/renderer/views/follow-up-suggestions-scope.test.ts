import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  setThreadGitBranch,
  setThreadStatus,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'

const SUGGESTION: FollowUpSuggestion = { id: 'run-tests', label: 'Run the tests' }

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('follow-up suggestions thread scope', () => {
  it('follows thread switches and does not refetch for renames', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const first = createThread(store)
    addMessage(store, first, 'user', 'fix the parser')
    addMessage(store, first, 'assistant', 'Fixed it.')
    let fetches = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base.agent,
        suggestFollowUps: () => {
          fetches += 1
          return Promise.resolve([SUGGESTION])
        },
      },
    }
    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', first, 'idle')
    await flush()
    const bubble = mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]')
    assert.ok(bubble, 'the finished turn offers its suggestion')
    assert.equal(fetches, 1)

    // This view stays on threads_changed (see follow-up-suggestions.ts), so
    // switches here emit it as real writers do.
    const second = createThread(store)
    store.setState({ activeThreadId: first })
    store.emit('threads_changed')
    await flush()
    setThreadTitle(store, first, 'Renamed')
    setThreadTitle(store, second, 'Renamed too')
    await flush()
    assert.equal(fetches, 1, 'renames do not refetch')
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))

    // Selecting the empty thread clears the bubbles.
    store.setState({ activeThreadId: second })
    store.emit('threads_changed')
    await flush()
    assert.equal(mount.root.querySelector('.follow-up-bubble'), null)

    // Back again: the cached suggestion returns without a second fetch.
    store.setState({ activeThreadId: first })
    store.emit('threads_changed')
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    assert.equal(fetches, 1)
    mount.destroy()
  })

  it('brings the bubbles back after a mid-turn metadata write, as the references show', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const thread = createThread(store)
    addMessage(store, thread, 'user', 'fix the parser')
    addMessage(store, thread, 'assistant', 'Fixed it.')
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: { ...base.agent, suggestFollowUps: () => Promise.resolve([SUGGESTION]) },
    }
    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', thread, 'idle')
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))

    // The next turn starts: the bubbles clear.
    setThreadStatus(store, thread, 'running')
    await flush()
    assert.equal(mount.root.querySelector('.follow-up-bubble'), null)

    // A metadata write during the turn (the checkout binding its branch) emits
    // threads_changed. On main the bubbles return here; a selection keyed on
    // the thread switch alone left them gone (the 613a72a screenshot regression).
    setThreadGitBranch(store, thread, 'copse/work')
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    mount.destroy()
  })

  it('starts one fetch per exchange while mid-turn writes keep emitting threads_changed', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const thread = createThread(store)
    addMessage(store, thread, 'user', 'fix the parser')
    addMessage(store, thread, 'assistant', 'Working on it.')
    let fetches = 0
    let settle: (suggestions: FollowUpSuggestion[]) => void = () => {}
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base.agent,
        suggestFollowUps: () => {
          fetches += 1
          return new Promise<FollowUpSuggestion[]>((resolve) => {
            settle = resolve
          })
        },
      },
    }
    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    setThreadStatus(store, thread, 'running')
    await flush()

    // A streaming turn emits threads_changed several times a second, and each
    // fetch costs git/gh processes and a small-model call in main. The fetch
    // already in flight for this exchange serves every one of them.
    for (let i = 0; i < 20; i++) {
      store.emit('threads_changed')
      await flush()
    }
    assert.equal(fetches, 1)

    settle([SUGGESTION])
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    store.emit('threads_changed')
    await flush()
    assert.equal(fetches, 1, 'the mid-turn set serves the rest of the turn')

    // That set saw only the start of the answer. The turn's end asks once more,
    // from the finished answer, and that set is kept for the exchange.
    setThreadStatus(store, thread, 'idle')
    await flush()
    assert.equal(fetches, 2)
    store.emit('threads_changed')
    await flush()
    assert.equal(fetches, 2, 'the end-of-turn fetch in flight serves later events')
    settle([SUGGESTION])
    await flush()
    store.emit('threads_changed')
    await flush()
    assert.equal(fetches, 2)
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    mount.destroy()
  })

  it('fetches again when a run that adds no message ends while the last fetch is out', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const thread = createThread(store)
    addMessage(store, thread, 'user', 'fix the parser')
    addMessage(store, thread, 'assistant', 'Fixed it.')
    let fetches = 0
    const pending: Array<(suggestions: FollowUpSuggestion[]) => void> = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base.agent,
        suggestFollowUps: () => {
          fetches += 1
          return new Promise<FollowUpSuggestion[]>((resolve) => {
            pending.push(resolve)
          })
        },
      },
    }
    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', thread, 'idle')
    await flush()
    assert.equal(fetches, 1)

    // A run that fails to start (a Copse Reviewer run's catch) goes running →
    // idle without adding a message, so the exchange is the same one. The run
    // invalidated the fetch still out; that fetch must not stand in for a new one.
    setThreadStatus(store, thread, 'running')
    await flush()
    setThreadStatus(store, thread, 'idle')
    await flush()
    assert.equal(fetches, 2)

    for (const resolve of pending) resolve([SUGGESTION])
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    mount.destroy()
  })

  it('fetches again for a background thread whose run adds no message', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const background = createThread(store)
    addMessage(store, background, 'user', 'fix the parser')
    addMessage(store, background, 'assistant', 'Fixed it.')
    const active = createThread(store)
    assert.equal(store.getState().activeThreadId, active)
    const pending: Array<(suggestions: FollowUpSuggestion[]) => void> = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base.agent,
        suggestFollowUps: () =>
          new Promise<FollowUpSuggestion[]>((resolve) => {
            pending.push(resolve)
          }),
      },
    }
    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', background, 'idle')
    await flush()
    assert.equal(pending.length, 1)

    // The same no-message run, on a thread that is not on screen: the set
    // fetched before the run must not stand for the one after it.
    setThreadStatus(store, background, 'running')
    await flush()
    setThreadStatus(store, background, 'idle')
    await flush()
    assert.equal(pending.length, 2)

    pending[0]?.([{ id: 'before-the-run', label: 'Before the run' }])
    pending[1]?.([SUGGESTION])
    await flush()
    store.setState({ activeThreadId: background })
    store.emit('threads_changed')
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    assert.equal(mount.root.querySelector('.follow-up-bubble[data-id="before-the-run"]'), null)
    mount.destroy()
  })

  it('drops a background fetch that answers during a run, so the run end fetches afresh', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const background = createThread(store)
    addMessage(store, background, 'user', 'fix the parser')
    addMessage(store, background, 'assistant', 'Fixed it.')
    createThread(store)
    const pending: Array<(suggestions: FollowUpSuggestion[]) => void> = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base.agent,
        suggestFollowUps: () =>
          new Promise<FollowUpSuggestion[]>((resolve) => {
            pending.push(resolve)
          }),
      },
    }
    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', background, 'idle')
    await flush()
    assert.equal(pending.length, 1)

    // The pre-run answer lands while the run is still going. It describes the
    // exchange as it stood before the run, so it must not become the set the
    // run's end shows.
    setThreadStatus(store, background, 'running')
    await flush()
    pending[0]?.([{ id: 'before-the-run', label: 'Before the run' }])
    await flush()
    setThreadStatus(store, background, 'idle')
    await flush()
    assert.equal(pending.length, 2)

    pending[1]?.([SUGGESTION])
    await flush()
    store.setState({ activeThreadId: background })
    store.emit('threads_changed')
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    assert.equal(mount.root.querySelector('.follow-up-bubble[data-id="before-the-run"]'), null)
    mount.destroy()
  })
})
