import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Thread } from '@shared/types/thread.ts'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createThreadArchiveReview } from './thread-archive-review.ts'

const thread: Thread = {
  id: 'old-thread',
  title: 'An earlier task',
  status: 'idle',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  createdAt: 1,
  updatedAt: 1,
}
const disposals: Array<() => void> = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => {
    dispose()
  })
  document.body.replaceChildren()
})
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount(decide: ApiClient['threads']['archiveDecision']): {
  store: ReturnType<typeof createStore>
  view: ReturnType<typeof createThreadArchiveReview>
  api: ApiClient
} {
  const store = createStore({
    activeProjectId: 'project',
    activeThreadId: thread.id,
    threads: [{ ...thread }],
  })
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    threads: {
      ...base.threads,
      archiveState: async (): ReturnType<ApiClient['threads']['archiveState']> => ({
        archived: [],
        review: [{ threadId: thread.id, reason: 'Completion has not been verified.' }],
      }),
      archiveDecision: decide,
    },
  }
  const view = createThreadArchiveReview(store, api)
  disposals.push(() => {
    view.dispose()
  })
  document.body.append(view.element)
  return { store, view, api }
}

it('asks before archiving uncertain work and keeps it on cancellation', async () => {
  const calls: string[] = []
  const { view, store } = mount(async (_pid, _tid, action) => {
    calls.push(action)
    return true
  })
  await settle()
  assert.equal(view.element.hidden, false)
  assert.match(view.element.textContent, /Finished with this thread/)
  assert.deepEqual(calls, [])
  view.element.querySelector<HTMLButtonElement>('button')?.click()
  await settle()
  assert.deepEqual(calls, ['keep'])
  assert.equal(store.getState().threads[0]?.archivedAt, undefined)
  assert.equal(view.element.hidden, true)
})

it('archives only after the explicit action succeeds', async () => {
  const { view, store } = mount(async () => true)
  await settle()
  const buttons = view.element.querySelectorAll<HTMLButtonElement>('button')
  buttons[1]?.click()
  await settle()
  assert.ok(store.getState().threads.find((item) => item.id === thread.id)?.archivedAt)
})

it('leaves a changed or busy thread visible when main rejects archival', async () => {
  const { view, store } = mount(async () => false)
  await settle()
  view.element.querySelectorAll<HTMLButtonElement>('button')[1]?.click()
  await settle()
  assert.equal(store.getState().threads[0]?.archivedAt, undefined)
  assert.equal(view.element.hidden, false)
  assert.match(document.body.textContent, /thread changed or has pending work/)
})

it('removes the review when the same thread starts running or gains a draft', async () => {
  const { view, store } = mount(async () => true)
  await settle()
  assert.equal(view.element.hidden, false)
  store.setState({ threads: [{ ...thread, status: 'running' }] })
  store.emit('threads_changed')
  assert.equal(view.element.hidden, true)
  store.setState({ threads: [{ ...thread }] })
  store.emit('threads_changed')
  await settle()
  assert.equal(view.element.hidden, false)
  store.setState({ threads: [{ ...thread, draftPrompt: 'More work' }] })
  store.emit('threads_changed')
  assert.equal(view.element.hidden, true)
})

it('rechecks a visible review when auto-archive settings change', async () => {
  const { view, store, api } = mount(async () => true)
  await settle()
  assert.equal(view.element.hidden, false)
  api.threads.archiveState = async (): ReturnType<ApiClient['threads']['archiveState']> => ({
    archived: [],
    review: [],
  })
  store.emit('settings_changed')
  await settle()
  assert.equal(view.element.hidden, true)
})
