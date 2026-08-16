import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RENDERER_RELOAD_MAX,
  RENDERER_RELOAD_WINDOW_MS,
  attachRendererCrashRecovery,
  initialRendererReloadState,
  planRendererCrashRecovery,
  type RendererCrashTarget,
  type RendererGoneDetails,
} from './renderer-crash-recovery.ts'

const CRASH: RendererGoneDetails = { reason: 'crashed', exitCode: 1 }

class FakeContents extends EventEmitter implements RendererCrashTarget {
  destroyed = false
  reloads = 0

  isDestroyed(): boolean {
    return this.destroyed
  }

  reload(): void {
    this.reloads += 1
  }
}

describe('planRendererCrashRecovery', () => {
  it('does not reload a clean window close', () => {
    const state = initialRendererReloadState()
    const decision = planRendererCrashRecovery({ reason: 'clean-exit', exitCode: 0 }, state, 1_000)
    assert.equal(decision.reload, false)
    assert.deepEqual(decision.next, state)
  })

  it('reloads the first crash and the second inside the window', () => {
    const first = planRendererCrashRecovery(CRASH, initialRendererReloadState(), 1_000)
    assert.equal(first.reload, true)
    assert.equal(first.next.recentCrashes, 1)

    const second = planRendererCrashRecovery(CRASH, first.next, 1_000 + 100)
    assert.equal(second.reload, true)
    assert.equal(second.next.recentCrashes, 2)
  })

  it('stops reloading after the cap so a boot-loop cannot spin', () => {
    let state = initialRendererReloadState()
    let now = 1_000
    for (let i = 0; i < RENDERER_RELOAD_MAX; i++) {
      const decision = planRendererCrashRecovery(CRASH, state, now)
      assert.equal(decision.reload, true)
      state = decision.next
      now += 10
    }
    const refused = planRendererCrashRecovery(CRASH, state, now + 10)
    assert.equal(refused.reload, false)
    assert.equal(refused.next.recentCrashes, RENDERER_RELOAD_MAX + 1)
  })

  it('resets the crash count after the window elapses', () => {
    const first = planRendererCrashRecovery(CRASH, initialRendererReloadState(), 1_000)
    const later = planRendererCrashRecovery(
      { reason: 'oom', exitCode: 137 },
      first.next,
      1_000 + RENDERER_RELOAD_WINDOW_MS,
    )
    assert.equal(later.reload, true)
    assert.equal(later.next.recentCrashes, 1)
  })
})

describe('attachRendererCrashRecovery', () => {
  it('reloads a live window and skips a destroyed one', () => {
    const logs: string[] = []
    const contents = new FakeContents()
    let now = 5_000
    attachRendererCrashRecovery(contents, {
      log: (message) => {
        logs.push(message)
      },
      now: () => now,
    })

    contents.emit('render-process-gone', {}, CRASH)
    assert.equal(contents.reloads, 1)
    assert.match(logs[0] ?? '', /reason=crashed/)

    contents.destroyed = true
    now += 20_000
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 })
    assert.equal(contents.reloads, 1)
  })
})
