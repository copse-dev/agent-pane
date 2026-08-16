import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import { DETERMINISTIC_FOLLOW_UP_IDS } from '@shared/follow-ups/presets.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountFollowUpSuggestions } from './follow-up-suggestions.ts'

const PROMPT_BUBBLE: FollowUpSuggestion = {
  id: 'run-tests',
  label: 'Run the tests',
  action: 'prompt',
  prompt: 'Run the relevant tests.',
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('follow-up Changes chip', () => {
  it('refreshes +/- counts from recursive working-tree events (#1753)', async () => {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'do the thing')
    addMessage(store, threadId, 'assistant', 'done')

    const listener: { current: ((root: string) => void) | null } = { current: null }
    let statsReads = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      agent: {
        ...base['agent'],
        suggestFollowUps: () => Promise.resolve([PROMPT_BUBBLE]),
      },
      git: {
        ...base['git'],
        changeStats: async () => {
          statsReads++
          return { additions: statsReads, deletions: 0 }
        },
        onWorkingTreeChanged: (handler: (root: string) => void): (() => void) => {
          listener.current = handler
          return () => {
            if (listener.current === handler) listener.current = null
          }
        },
      },
    }

    const mount = mountFollowUpSuggestions(store, api, () => {})
    document.body.append(mount.root)
    store.emit('thread_status_changed', threadId, 'idle')
    await flush()

    assert.equal(statsReads, 1)
    assert.equal(
      mount.root.querySelector(`[data-id="${DETERMINISTIC_FOLLOW_UP_IDS.changes}"]`)?.textContent,
      'Changes+1-0',
    )
    assert.ok(listener.current)

    listener.current('/repo')
    await new Promise<void>((resolve) => setTimeout(resolve, 450))
    await flush()
    assert.equal(statsReads, 2)
    assert.equal(
      mount.root.querySelector(`[data-id="${DETERMINISTIC_FOLLOW_UP_IDS.changes}"]`)?.textContent,
      'Changes+2-0',
    )

    mount.destroy()
    assert.equal(listener.current, null)
  })
})
