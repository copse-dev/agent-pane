import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import type { ThreadArchiveState } from '@shared/threads/auto-archive.ts'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createArchivedThreads } from './archived-threads.ts'

const project = { id: 'project', name: 'Earlier work', path: '/workspace' }
const thread: Thread = {
  id: 'archived',
  title: 'Finished task',
  status: 'idle',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  createdAt: 1,
  updatedAt: 2,
  archivedAt: 2,
}
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
afterEach(() => {
  document.body.replaceChildren()
})

it('loads archives on demand, filters titles, and restores through main', async () => {
  const store = createStore({ activeProjectId: project.id, projects: [project] })
  const api = createFakeApi()
  let reads = 0
  const actions: string[] = []
  api.threads.archiveState = async (): Promise<ThreadArchiveState> => {
    reads++
    return { archived: [thread], review: [] }
  }
  api.threads.archiveDecision = async (_pid, tid, action): Promise<boolean> => {
    actions.push(`${tid}/${action}`)
    return true
  }
  api.threads.loadProject = async (): Promise<Thread[]> => {
    const { archivedAt: _archivedAt, ...restored } = thread
    return [{ ...restored, updatedAt: 100, messagesLoaded: false }]
  }
  let restored = false
  const view = createArchivedThreads(store, api, () => {
    restored = true
  })
  document.body.append(view.element)
  assert.equal(reads, 0)
  view.show([project], 'finished')
  await settle()
  assert.match(view.element.textContent, /Finished task/)
  view.show([project], 'finished')
  assert.equal(reads, 1)
  view.element.querySelector<HTMLButtonElement>('button')?.click()
  await settle()
  assert.deepEqual(actions, ['archived/restore'])
  assert.equal(restored, true)
  assert.equal(store.getState().activeThreadId, thread.id)
  assert.equal(store.getState().threads[0]?.archivedAt, undefined)
  view.show([project], 'unmatched')
  await settle()
  assert.match(view.element.textContent, /No archived threads/)
  view.hide()
})

it('ignores an old project response after the filter changes', async () => {
  const api = createFakeApi()
  let release: (state: ThreadArchiveState) => void = () => {}
  const pending = new Promise<ThreadArchiveState>((resolve) => {
    release = resolve
  })
  api.threads.archiveState = async (pid): Promise<ThreadArchiveState> =>
    pid === project.id ? pending : { archived: [], review: [] }
  const view = createArchivedThreads(createStore(), api, () => {})
  view.show([project], '')
  view.show([{ ...project, id: 'other' }], '')
  await settle()
  release({ archived: [thread], review: [] })
  await settle()
  assert.match(view.element.textContent, /No archived threads/)
  assert.doesNotMatch(view.element.textContent, /Finished task/)
  view.hide()
})
