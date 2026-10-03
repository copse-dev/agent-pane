import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountRoadmapAttempts } from './roadmap-attempts.ts'

it('shows unverified criteria without a report and opens the owning task plan', async () => {
  const store = createStore({ activeProjectId: 'p' })
  const older = createThread(store, 'Previous work')
  const latest = createThread(store, 'Current work')
  const plan: StoredThreadPlan = {
    meta: {
      planId: 'plan',
      threadId: older,
      title: 'Earlier approved plan',
      status: 'approved',
      currentRevision: 1,
      approvedRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    body: '# Definition of done\n- Keep the draft.\n- Run the tests.',
    contentHash: 'hash',
    comments: [],
    approval: null,
    completion: null,
  }
  const base = createFakeApi()
  const api = {
    ...base,
    plans: {
      ...base.plans,
      get: async (_project: string, thread: string): Promise<StoredThreadPlan | null> =>
        thread === older ? plan : null,
    },
  }
  const view = mountRoadmapAttempts(api, store)
  let opened = ''
  const unsub = store.on('thread_plan_open', () => {
    opened = store.getState().activeThreadId ?? ''
  })
  try {
    view.show({ thread: latest, threadHistory: JSON.stringify([latest, older]) })
    await Promise.resolve()
    assert.match(view.element.textContent, /Earlier attempts \(1\)/)
    assert.match(view.element.textContent, /Approved r1 · 2 unverified/)
    view.element.querySelector<HTMLButtonElement>('.roadmap-previous-attempts button')?.click()
    assert.equal(opened, older)
    assert.equal(store.getState().activeThreadId, older)
  } finally {
    unsub()
    view.destroy()
  }
})

it('discards an earlier selection’s delayed plan response', async () => {
  const store = createStore({ activeProjectId: 'p' })
  const base = createFakeApi()
  let resolve: ((plan: StoredThreadPlan | null) => void) | undefined
  const pending = new Promise<StoredThreadPlan | null>((done) => {
    resolve = done
  })
  const api = {
    ...base,
    plans: { ...base.plans, get: (): Promise<StoredThreadPlan | null> => pending },
  }
  const view = mountRoadmapAttempts(api, store)
  view.show({ thread: 'old' })
  view.show({})
  resolve?.(null)
  await Promise.resolve()
  assert.equal(view.element.hidden, true)
  assert.equal(view.element.textContent, '')
  view.destroy()
})
