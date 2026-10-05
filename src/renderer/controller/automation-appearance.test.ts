import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '@shared/types'
import { createStore } from '@shared/store/store.ts'
import { setThreadStatus } from '@shared/store/thread-helpers.ts'
import { attachAutomationAppearance, AUTOMATION_ACTIVE_ATTRIBUTE } from './automation-appearance.ts'

function thread(id: string, status: Thread['status'], automated: boolean): Thread {
  return {
    id,
    title: id,
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(automated
      ? { automation: { scheduleId: 'schedule-1', scheduleName: 'Nightly review', triggeredAt: 1 } }
      : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

afterEach(() => {
  document.documentElement.removeAttribute(AUTOMATION_ACTIVE_ATTRIBUTE)
})

describe('automation appearance', () => {
  it('follows scheduled runs and restores the saved appearance after the last one settles', async () => {
    const store = createStore({ threads: [thread('scheduled', 'idle', true)] })
    const calls: boolean[] = []
    const detach = attachAutomationAppearance(store, {
      setAutomationMode: async (active) => {
        calls.push(active)
      },
    })

    assert.equal(document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE), false)
    assert.deepEqual(calls, [false])

    setThreadStatus(store, 'scheduled', 'running')
    assert.equal(document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE), true)
    assert.deepEqual(calls, [false, true])

    setThreadStatus(store, 'scheduled', 'idle')
    assert.equal(document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE), false)
    assert.deepEqual(calls, [false, true, false])

    detach()
    await Promise.resolve()
  })

  it('ignores interactive runs and keeps automation mode while another schedule is running', () => {
    const store = createStore({
      threads: [thread('interactive', 'idle', false), thread('scheduled', 'running', true)],
    })
    const calls: boolean[] = []
    const detach = attachAutomationAppearance(store, {
      setAutomationMode: async (active) => {
        calls.push(active)
      },
    })

    setThreadStatus(store, 'interactive', 'running')
    assert.equal(document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE), true)
    assert.deepEqual(calls, [true])

    setThreadStatus(store, 'scheduled', 'error')
    assert.equal(document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE), false)
    assert.deepEqual(calls, [true, false])

    detach()
  })
})
