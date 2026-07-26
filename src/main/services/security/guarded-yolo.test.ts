import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GUARDED_YOLO_ARM_TTL_MS } from '@shared/types/guarded-yolo.ts'
import { GuardedYoloRegistry } from './guarded-yolo.ts'

describe('GuardedYoloRegistry', () => {
  it('is off by default and never restores from persisted settings', () => {
    const registry = new GuardedYoloRegistry()
    assert.equal(registry.state('thread-1', false).phase, 'off')
  })

  it('arms one thread, activates for one run, then expires at run end', () => {
    const changed: string[] = []
    const registry = new GuardedYoloRegistry({ schedule: (): (() => void) => () => {} })
    registry.onChanged((threadId) => changed.push(threadId))

    registry.arm('thread-1')
    assert.equal(registry.state('thread-1', true).phase, 'armed')
    assert.equal(registry.state('thread-2', true).phase, 'off')
    assert.equal(registry.activateForRun('thread-1'), true)
    assert.equal(registry.isActive('thread-1'), true)
    assert.equal(registry.state('thread-1', true).expiresAt, null)

    registry.finishRun('thread-1')
    assert.equal(registry.state('thread-1', true).phase, 'off')
    assert.deepEqual(changed, ['thread-1', 'thread-1', 'thread-1'])
  })

  it('expires an unused armed grant after the fixed idle window', () => {
    let now = 100
    let expire = (): void => assert.fail('expiry callback was not scheduled')
    let scheduledDelay = 0
    const registry = new GuardedYoloRegistry({
      now: (): number => now,
      schedule: (callback, delay): (() => void) => {
        expire = callback
        scheduledDelay = delay
        return (): void => {
          expire = (): void => assert.fail('expiry callback was cancelled')
        }
      },
    })

    registry.arm('thread-1')
    assert.equal(scheduledDelay, GUARDED_YOLO_ARM_TTL_MS)
    now += GUARDED_YOLO_ARM_TTL_MS
    expire()
    assert.equal(registry.state('thread-1', false).phase, 'off')
  })

  it('reports the effective containment state truthfully', () => {
    const registry = new GuardedYoloRegistry({ schedule: (): (() => void) => () => {} })
    registry.arm('thread-1')
    assert.equal(registry.state('thread-1', true).containment, 'project-sandbox')
    assert.equal(registry.state('thread-1', false).containment, 'unsandboxed')
  })
})
