import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GuardedYoloRegistry } from './guarded-yolo.ts'

describe('GuardedYoloRegistry', () => {
  it('is off by default and never restores from persisted settings', () => {
    const registry = new GuardedYoloRegistry()
    assert.equal(registry.state('thread-1', false).phase, 'off')
  })

  it('arms one thread, activates for the thread, and persists across runs', () => {
    const changed: string[] = []
    const registry = new GuardedYoloRegistry()
    registry.onChanged((threadId) => changed.push(threadId))

    registry.arm('thread-1')
    assert.equal(registry.state('thread-1', true).phase, 'armed')
    assert.equal(registry.state('thread-2', true).phase, 'off')
    assert.equal(registry.activateForRun('thread-1'), true)
    assert.equal(registry.isActive('thread-1'), true)
    assert.equal(registry.state('thread-1', true).expiresAt, null)

    // finishRun is now a no-op — YOLO stays active for the thread.
    registry.finishRun('thread-1')
    assert.equal(registry.state('thread-1', true).phase, 'active')
    assert.equal(registry.isActive('thread-1'), true)
    assert.deepEqual(changed, ['thread-1', 'thread-1'])
  })

  it('arms without an expiry timer — armed state persists until activated or disabled', () => {
    const registry = new GuardedYoloRegistry()

    registry.arm('thread-1')
    assert.equal(registry.state('thread-1', true).phase, 'armed')
    assert.equal(registry.state('thread-1', true).expiresAt, null)
  })

  it('reports the effective containment state truthfully', () => {
    const registry = new GuardedYoloRegistry()
    registry.arm('thread-1')
    assert.equal(registry.state('thread-1', true).containment, 'project-sandbox')
    assert.equal(registry.state('thread-1', false).containment, 'unsandboxed')
  })
})
