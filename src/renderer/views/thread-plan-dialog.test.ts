import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread, openNewThread, switchThread } from '@shared/store/thread-helpers.ts'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountThreadPlanControl } from './thread-plan-dialog.ts'

const BODY =
  '# Goal\nFix login\n# Constraints\nNone\n# Scope\nLogin form\n# Definition of done\n- Expired sessions recover'
function plan(threadId: string): StoredThreadPlan {
  return {
    meta: {
      planId: 'cbcdf12c-b6aa-4f8e-966b-f409e82ca604',
      threadId,
      title: 'Fix login',
      status: 'draft',
      currentRevision: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    body: BODY,
    contentHash: 'hash',
    comments: [],
    approval: null,
    completion: null,
  }
}
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
function control<K extends keyof HTMLElementTagNameMap>(
  selector: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const value = document.querySelector<HTMLElementTagNameMap[K]>(selector)
  assert.ok(value, selector)
  assert.equal(value.tagName.toLowerCase(), tag)
  return value
}
function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('#thread-plan-dialog button'),
  ].find((item) => item.textContent === label)
  assert.ok(found, label)
  return found
}
function setup(
  approved = false,
  empty = false,
  allowCreate = false,
): ReturnType<typeof mountThreadPlanControl> & {
  store: ReturnType<typeof createStore>
  dialog: HTMLDialogElement
} {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  let stored = empty ? null : plan(threadId)
  if (approved && stored) {
    stored.meta.status = 'approved'
    stored.meta.approvedRevision = 2
    stored.approval = {
      planId: stored.meta.planId,
      approvedRevision: 2,
      approvedAt: 3,
      executionProfileId: 'implementation',
      contentHash: stored.contentHash,
    }
  }
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    plans: {
      get: async () => stored,
      revision: async () => 'Earlier revision',
      change: async (_projectId, _threadId, input) => {
        if (allowCreate && input.action === 'create') {
          stored = plan(threadId)
          stored.meta.currentRevision = 1
          stored.meta.title = input.title
          stored.body = input.body
          return stored
        }
        throw new Error('Plan revision changed')
      },
    },
  }
  const mounted = mountThreadPlanControl(api, store, async () => {})
  document.body.append(mounted.button)
  const dialog = control('#thread-plan-dialog', 'dialog')
  Object.defineProperties(dialog, {
    showModal: {
      value: () => {
        dialog.setAttribute('open', '')
      },
    },
    close: {
      value: () => {
        dialog.removeAttribute('open')
      },
    },
  })
  return { ...mounted, store, dialog }
}
afterEach(() => {
  document.body.replaceChildren()
})
describe('thread plan review', () => {
  it('retains a newly saved plan when opening and switching tasks without sending a message', async () => {
    const mounted = setup(false, true, true)
    const planThreadId = mounted.store.getState().activeThreadId
    assert.ok(planThreadId)
    mounted.button.click()
    await settle()
    button('Start planning').click()
    await settle()
    assert.equal(control('.thread-plan-error', 'p').textContent, '')
    button('Close').click()
    assert.notEqual(openNewThread(mounted.store), planThreadId)
    assert.ok(mounted.store.getState().threads.some((thread) => thread.id === planThreadId))
    switchThread(mounted.store, planThreadId)
    mounted.button.click()
    await settle()
    assert.equal(control('[data-testid="plan-status"]', 'span').textContent, 'draft · r1')
    mounted.destroy()
  })
  it('protects new title and body edits from Escape and idle refresh until explicitly discarded', async () => {
    const mounted = setup(false, true)
    mounted.button.click()
    await settle()
    const title = control('#plan-title', 'input')
    const originalTitle = title.value
    const untouched = new Event('cancel', { cancelable: true })
    mounted.dialog.dispatchEvent(untouched)
    assert.equal(untouched.defaultPrevented, false)
    title.value = 'My new plan'
    title.dispatchEvent(new Event('input'))
    const cancel = new Event('cancel', { cancelable: true })
    mounted.dialog.dispatchEvent(cancel)
    assert.equal(cancel.defaultPrevented, true)
    assert.ok(button('Discard edits and close'))
    title.value = originalTitle
    title.dispatchEvent(new Event('input'))
    assert.ok(button('Close'))
    button('Markdown').click()
    const body = control('#plan-source', 'textarea')
    body.value = BODY
    body.dispatchEvent(new Event('input'))
    const bodyCancel = new Event('cancel', { cancelable: true })
    mounted.dialog.dispatchEvent(bodyCancel)
    assert.equal(bodyCancel.defaultPrevented, true)
    const threadId = mounted.store.getState().activeThreadId
    assert.ok(threadId)
    mounted.store.emit('thread_status_changed', threadId, 'idle')
    await settle()
    assert.equal(body.value, BODY)
    button('Discard edits and close').click()
    assert.equal(mounted.dialog.open, false)
    mounted.destroy()
  })
  it('disables approval and comments for unsaved changes; stale saves keep the editor intact', async () => {
    const mounted = setup()
    mounted.button.click()
    await settle()
    button('Markdown').click()
    const body = control('#plan-source', 'textarea')
    body.value += '\n- Additional criterion'
    body.dispatchEvent(new Event('input'))
    assert.equal(button('Approve and implement').disabled, true)
    assert.equal(button('Add passage feedback').disabled, true)
    button('Save revision').click()
    await settle()
    assert.match(control('.thread-plan-error', 'p').textContent, /revision changed/)
    assert.match(body.value, /Additional criterion/)
    assert.equal(button('Approve and implement').disabled, true)
    mounted.destroy()
  })
  it('shows missing completion as unverified and locks an approved body', async () => {
    const mounted = setup(true)
    mounted.button.click()
    await settle()
    assert.equal(control('#plan-body', 'div').getAttribute('contenteditable'), 'false')
    assert.equal(
      document.querySelectorAll('.thread-plan-result[data-status="unverified"]').length,
      1,
    )
    assert.match(control('.thread-plan-results', 'section').textContent, /No completion report yet/)
    mounted.destroy()
  })
  it('makes history read-only and closes on thread switch', async () => {
    const mounted = setup()
    mounted.button.click()
    await settle()
    const history = control('#plan-revision', 'select')
    history.value = '1'
    history.dispatchEvent(new Event('change'))
    await settle()
    assert.equal(control('#plan-body', 'div').textContent, 'Earlier revision')
    assert.equal(control('#plan-body', 'div').getAttribute('contenteditable'), 'false')
    assert.equal(button('Approve and implement').hidden, true)
    createThread(mounted.store)
    assert.equal(mounted.dialog.open, false)
    mounted.destroy()
  })
})
