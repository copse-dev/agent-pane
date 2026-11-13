import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { deleteThreadAfterNativeReview } from './delete-thread.ts'

function setup(remove: () => Promise<void>): {
  store: ReturnType<typeof createStore>
  api: ApiClient
  doomed: string
} {
  const store = createStore()
  store.setState({ activeProjectId: 'project' })
  createThread(store)
  const doomed = createThread(store)
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    threads: { ...base.threads, delete: remove },
  }
  return { store, api, doomed }
}

test('keeps the renderer thread when native-confirmed deletion is denied', async () => {
  const { store, api, doomed } = setup(() => Promise.reject(new Error('cancelled')))

  await assert.rejects(deleteThreadAfterNativeReview(store, api, 'project', doomed), /cancelled/)

  assert.ok(store.getState().threads.some((thread) => thread.id === doomed))
})

test('removes the renderer thread only after main completes deletion', async () => {
  let completed = false
  const { store, api, doomed } = setup(async () => {
    completed = true
  })

  await deleteThreadAfterNativeReview(store, api, 'project', doomed)

  assert.equal(completed, true)
  assert.equal(
    store.getState().threads.some((thread) => thread.id === doomed),
    false,
  )
})
