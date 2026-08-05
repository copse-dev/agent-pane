import '../../../tests/setup-dom.ts'
import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Thread } from '@shared/types'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from './confirm-dialog.ts'
import { mountCloseConfirm, summariseWorkingThreads, workingThreadTitles } from './close-confirm.ts'

/** Let the confirm promise chain (dialog → respond) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function thread(id: string, title: string, status: Thread['status'] = 'idle'): Thread {
  return {
    id,
    title,
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

type CloseConfirmHandler = (req: { id: string }) => void

const responses: { id: string; confirmed: boolean }[] = []
let emit: CloseConfirmHandler = (): void => {}

const api = ((): ApiClient => {
  const base = createFakeApi()
  return {
    ...base,
    closeConfirm: {
      respond: (id: string, confirmed: boolean): Promise<void> => {
        responses.push({ id, confirmed })
        return Promise.resolve()
      },
      onRequest: (handler: CloseConfirmHandler): (() => void) => {
        emit = handler
        return (): void => {}
      },
    },
  } satisfies ApiClient
})()

beforeEach((): void => {
  mountConfirmDialog()
})

afterEach((): void => {
  document.getElementById('confirm-dialog')?.remove()
  responses.length = 0
  emit = (): void => {}
})

describe('close-confirm', () => {
  it('lets the close through without a prompt when nothing is running', async () => {
    const store = createStore({ threads: [thread('a', 'Idle'), thread('b', 'Also idle')] })
    mountCloseConfirm(api, store)

    emit({ id: 'close-1' })
    await flush()

    assert.equal(document.getElementById('confirm-dialog')?.hasAttribute('open'), false)
    assert.deepEqual(responses, [{ id: 'close-1', confirmed: true }])
  })

  it('warns and refuses the close while a thread is working', async () => {
    const store = createStore({
      threads: [thread('a', 'Idle'), thread('b', 'Fix login', 'running')],
    })
    mountCloseConfirm(api, store)

    emit({ id: 'close-2' })
    await flush()

    const dialog = qsRequired<HTMLDialogElement>(document, '#confirm-dialog')
    assert.ok(dialog.open)
    assert.equal(
      qsRequired(dialog, '.confirm-dialog-message').textContent,
      'Close Copse while the agent is still working?',
    )
    assert.match(qsRequired(dialog, '.confirm-dialog-detail').textContent, /Fix login is/)
    assert.equal(qsRequired(dialog, '.confirm-dialog-confirm').textContent, 'Close anyway')

    clickActiveConfirmDialogCancel()
    await flush()
    assert.deepEqual(responses, [{ id: 'close-2', confirmed: false }])
  })

  it('allows the close when the user confirms anyway', async () => {
    const store = createStore({ threads: [thread('b', 'Fix login', 'running')] })
    mountCloseConfirm(api, store)

    emit({ id: 'close-3' })
    await flush()

    clickActiveConfirmDialogConfirm()
    await flush()
    assert.deepEqual(responses, [{ id: 'close-3', confirmed: true }])
  })

  it('counts the running threads in the plural message', async () => {
    const store = createStore({
      threads: [thread('a', 'Fix login', 'running'), thread('b', 'Rename tests', 'running')],
    })
    mountCloseConfirm(api, store)

    emit({ id: 'close-4' })
    await flush()

    const dialog = qsRequired<HTMLDialogElement>(document, '#confirm-dialog')
    assert.equal(
      qsRequired(dialog, '.confirm-dialog-message').textContent,
      'Close Copse while 2 threads are still working?',
    )
    assert.match(
      qsRequired(dialog, '.confirm-dialog-detail').textContent,
      /Fix login and Rename tests are mid-turn/,
    )
    clickActiveConfirmDialogCancel()
  })

  it('names an untitled running thread rather than showing a blank', () => {
    const store = createStore({ threads: [thread('a', '   ', 'running')] })
    assert.deepEqual(workingThreadTitles(store), ['Untitled thread'])
  })

  it('collapses the tail of a long list into a count', () => {
    assert.equal(summariseWorkingThreads(['One']), 'One')
    assert.equal(summariseWorkingThreads(['One', 'Two']), 'One and Two')
    assert.equal(summariseWorkingThreads(['One', 'Two', 'Three']), 'One, Two and Three')
    assert.equal(
      summariseWorkingThreads(['One', 'Two', 'Three', 'Four', 'Five']),
      'One, Two, Three and 2 more',
    )
  })
})
