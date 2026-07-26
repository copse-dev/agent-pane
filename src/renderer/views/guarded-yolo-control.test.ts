import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GuardedYoloState } from '@shared/types/guarded-yolo.ts'
import { mountGuardedYoloControl } from './guarded-yolo-control.ts'

function createApi(): {
  api: Pick<ApiClient, 'security'>
  emit: (state: GuardedYoloState) => void
  enabled: string[]
  disabled: string[]
} {
  const states = new Map<string, GuardedYoloState>()
  const listeners = new Set<(state: GuardedYoloState) => void>()
  const enabled: string[] = []
  const disabled: string[] = []
  const off = (threadId: string): GuardedYoloState => ({
    threadId,
    phase: 'off',
    containment: 'unsandboxed',
    expiresAt: null,
  })
  const emit = (state: GuardedYoloState): void => {
    states.set(state.threadId, state)
    for (const listener of listeners) listener(state)
  }
  const security: ApiClient['security'] = {
    getGuardedYolo: async (threadId) => states.get(threadId) ?? off(threadId),
    enableGuardedYolo: async (threadId) => {
      enabled.push(threadId)
      const state: GuardedYoloState = {
        threadId,
        phase: 'armed',
        containment: 'project-sandbox',
        expiresAt: 123,
      }
      states.set(threadId, state)
      return state
    },
    disableGuardedYolo: async (threadId) => {
      disabled.push(threadId)
      const state = off(threadId)
      states.set(threadId, state)
      return state
    },
    onGuardedYoloChanged: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return { api: { security }, emit, enabled, disabled }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('Guarded YOLO composer control', () => {
  it('shows an explicit persistent danger indicator and containment state', async () => {
    const harness = createApi()
    let threadId: string | null = 'thread-1'
    const control = mountGuardedYoloControl(
      harness.api,
      () => threadId,
      () => {},
    )
    document.body.append(control.element)
    await settle()

    assert.equal(control.element.hidden, true)
    assert.match(control.menuLabel(), /Enable Guarded YOLO/)

    control.toggle()
    await settle()
    assert.deepEqual(harness.enabled, ['thread-1'])
    assert.equal(control.element.hidden, false)
    assert.equal(control.element.dataset['phase'], 'armed')
    assert.equal(control.element.dataset['containment'], 'project-sandbox')
    assert.match(control.element.textContent, /armed for the next turn/i)
    assert.match(control.element.textContent, /external commands may run unsandboxed/i)
    assert.equal(control.menuLabel(), 'Disable Guarded YOLO')

    harness.emit({
      threadId: 'thread-1',
      phase: 'active',
      containment: 'unsandboxed',
      expiresAt: null,
    })
    assert.match(control.element.textContent, /active for this turn/i)
    assert.match(control.element.textContent, /No OS sandbox/i)

    control.element.querySelector<HTMLButtonElement>('.guarded-yolo-disable')?.click()
    await settle()
    assert.deepEqual(harness.disabled, ['thread-1'])
    assert.equal(control.element.hidden, true)

    threadId = null
    control.refresh()
    assert.equal(control.element.hidden, true)
    control.destroy()
  })

  it('keeps state scoped to the active thread', async () => {
    const harness = createApi()
    let threadId: string | null = 'thread-1'
    const control = mountGuardedYoloControl(
      harness.api,
      () => threadId,
      () => {},
    )
    document.body.append(control.element)
    await settle()

    harness.emit({
      threadId: 'thread-2',
      phase: 'armed',
      containment: 'unsandboxed',
      expiresAt: 123,
    })
    assert.equal(control.element.hidden, true)

    threadId = 'thread-2'
    control.refresh()
    await settle()
    assert.equal(control.element.hidden, false)
    assert.equal(control.element.dataset['phase'], 'armed')
    control.destroy()
  })
})
