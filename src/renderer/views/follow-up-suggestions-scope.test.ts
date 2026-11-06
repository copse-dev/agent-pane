import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadTitle } from '@shared/store/thread-helpers.ts'
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
  it('follows the active thread from setState alone, and ignores renames', async () => {
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

    const second = createThread(store)
    store.setState({ activeThreadId: first })
    await flush()
    setThreadTitle(store, first, 'Renamed')
    setThreadTitle(store, second, 'Renamed too')
    await flush()
    assert.equal(fetches, 1, 'renames do not refetch')
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))

    // No event: selecting the empty thread clears the bubbles.
    store.setState({ activeThreadId: second })
    await flush()
    assert.equal(mount.root.querySelector('.follow-up-bubble'), null)

    // Back again: the cached suggestion returns without a second fetch.
    store.setState({ activeThreadId: first })
    await flush()
    assert.ok(mount.root.querySelector('.follow-up-bubble[data-id="run-tests"]'))
    assert.equal(fetches, 1)

    // Sending a message (the thread is still idle) suggests nothing new.
    mount.clearSuggestions()
    addMessage(store, first, 'user', 'Run the tests')
    await flush()
    assert.equal(fetches, 1, 'no suggestions are billed for the message just sent')
    mount.destroy()
  })
})
