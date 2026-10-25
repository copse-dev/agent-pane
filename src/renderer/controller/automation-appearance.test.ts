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
  for (const testAutomation of [false, true]) {
    it(`keeps test automation mode ${String(testAutomation)} independently of scheduled runs`, () => {
      const store = createStore({ threads: [thread('scheduled', 'idle', true)] })
      const detach = attachAutomationAppearance(testAutomation)
      const assertAppearance = (): void => {
        assert.equal(
          document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE),
          testAutomation,
        )
      }
      assertAppearance()
      setThreadStatus(store, 'scheduled', 'running')
      assertAppearance()
      setThreadStatus(store, 'scheduled', 'idle')
      assertAppearance()
      detach()
      assert.equal(document.documentElement.hasAttribute(AUTOMATION_ACTIVE_ATTRIBUTE), false)
    })
  }
})
