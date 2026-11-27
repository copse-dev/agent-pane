import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCrashLoopChoice,
  RENDERER_CRASH_LOOP_MAX,
  RENDERER_CRASH_LOOP_WINDOW_MS,
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
    assert.deepEqual(first.next.crashes, [1_000])

    const second = planRendererCrashRecovery(CRASH, first.next, 1_000 + 100)
    assert.equal(second.reload, true)
    assert.deepEqual(second.next.crashes, [1_000, 1_100])
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
    assert.equal(refused.loop, true)
    assert.deepEqual(refused.stoppedBy, {
      crashes: RENDERER_RELOAD_MAX + 1,
      windowMs: RENDERER_RELOAD_WINDOW_MS,
    })
    assert.equal(refused.next.crashes.length, RENDERER_RELOAD_MAX + 1)
  })

  it('resets the crash count after the window elapses', () => {
    const first = planRendererCrashRecovery(CRASH, initialRendererReloadState(), 1_000)
    const later = planRendererCrashRecovery(
      { reason: 'oom', exitCode: 137 },
      first.next,
      1_000 + RENDERER_RELOAD_WINDOW_MS,
    )
    assert.equal(later.reload, true)
    assert.equal(later.loop, false)
  })

  it('stops a slow crash loop that the short window never catches (#4445)', () => {
    // The affected profile crashed about every 40 seconds.
    let state = initialRendererReloadState()
    let now = 1_000
    for (let i = 0; i < RENDERER_CRASH_LOOP_MAX; i++) {
      const decision = planRendererCrashRecovery(CRASH, state, now)
      assert.equal(decision.reload, true, `crash ${String(i + 1)} reloads`)
      state = decision.next
      now += 40_000
    }
    const refused = planRendererCrashRecovery(CRASH, state, now)
    assert.equal(refused.reload, false)
    assert.equal(refused.loop, true)
    assert.deepEqual(refused.stoppedBy, {
      crashes: RENDERER_CRASH_LOOP_MAX + 1,
      windowMs: RENDERER_CRASH_LOOP_WINDOW_MS,
    })
  })

  it('forgets crashes older than the loop window', () => {
    let state = initialRendererReloadState()
    let now = 1_000
    for (let i = 0; i < RENDERER_CRASH_LOOP_MAX; i++) {
      state = planRendererCrashRecovery(CRASH, state, now).next
      now += 40_000
    }
    const later = planRendererCrashRecovery(CRASH, state, 1_000 + RENDERER_CRASH_LOOP_WINDOW_MS)
    assert.equal(later.reload, true)
    assert.equal(later.next.crashes.length, RENDERER_CRASH_LOOP_MAX)
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

  it('adds what the window was doing to the line for a crash, not for a clean exit', () => {
    const logs: string[] = []
    const contents = new FakeContents()
    let context: string | null = 'lastLargeIpc=threads:create estimated<=612MB ago=1200ms'
    attachRendererCrashRecovery(contents, {
      log: (message) => {
        logs.push(message)
      },
      now: () => 5_000,
      context: () => context,
    })

    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    assert.equal(
      logs[0],
      '[renderer] process gone reason=crashed exitCode=5 ' +
        'lastLargeIpc=threads:create estimated<=612MB ago=1200ms — reloading',
    )

    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    assert.equal(logs[1], '[renderer] process gone reason=clean-exit exitCode=0')

    context = null
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    assert.equal(logs[2], '[renderer] process gone reason=crashed exitCode=5 — reloading')
  })

  it('records each crash with what it did, and not a clean exit', () => {
    const records: Array<{ reason: string; action: string; context: string | null }> = []
    const contents = new FakeContents()
    let now = 5_000
    attachRendererCrashRecovery(contents, {
      log: () => undefined,
      now: () => now,
      context: () => 'lastLargeIpc=threads:create',
      record: (record) => {
        records.push({ reason: record.reason, action: record.action, context: record.context })
      },
    })
    contents.emit('render-process-gone', {}, CRASH)
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    now += 1
    contents.emit('render-process-gone', {}, CRASH)
    now += 1
    contents.emit('render-process-gone', {}, CRASH)
    assert.deepEqual(records, [
      { reason: 'crashed', action: 'reloaded', context: 'lastLargeIpc=threads:create' },
      { reason: 'crashed', action: 'reloaded', context: 'lastLargeIpc=threads:create' },
      { reason: 'crashed', action: 'stopped', context: 'lastLargeIpc=threads:create' },
    ])
  })

  it('tells the user once a crash loop stops recovery, and retries from a clean slate', () => {
    const logs: string[] = []
    const contents = new FakeContents()
    let now = 1_000
    let retry: (() => void) | null = null
    let notices = 0
    attachRendererCrashRecovery(contents, {
      log: (message) => {
        logs.push(message)
      },
      now: () => now,
      onCrashLoop: (again) => {
        notices += 1
        retry = again
      },
    })
    for (let i = 0; i <= RENDERER_CRASH_LOOP_MAX; i++) {
      contents.emit('render-process-gone', {}, CRASH)
      now += 40_000
    }
    assert.equal(contents.reloads, RENDERER_CRASH_LOOP_MAX)
    assert.equal(notices, 1)
    assert.match(logs.at(-1) ?? '', /not reloading: 4 crashes in 10 minutes$/)
    assert.ok(retry)
    const again: () => void = retry
    again()
    assert.equal(contents.reloads, RENDERER_CRASH_LOOP_MAX + 1)
    // The history was cleared, so the next crash reloads again.
    contents.emit('render-process-gone', {}, CRASH)
    assert.equal(contents.reloads, RENDERER_CRASH_LOOP_MAX + 2)
  })

  it('names the 15-second cap in the log when a fast burst stops recovery', () => {
    const logs: string[] = []
    const contents = new FakeContents()
    attachRendererCrashRecovery(contents, {
      log: (message) => {
        logs.push(message)
      },
      now: () => 1_000,
    })
    for (let i = 0; i <= RENDERER_RELOAD_MAX; i++) contents.emit('render-process-gone', {}, CRASH)
    assert.match(logs.at(-1) ?? '', /not reloading: 3 crashes in 15 seconds$/)
  })

  it('keeps recovering when the record callback throws', () => {
    const contents = new FakeContents()
    attachRendererCrashRecovery(contents, {
      log: () => undefined,
      record: () => {
        throw new Error('disk full')
      },
    })
    contents.emit('render-process-gone', {}, CRASH)
    assert.equal(contents.reloads, 1)
  })
})

describe('applyCrashLoopChoice', () => {
  it('reloads on Reload Window and destroys the window otherwise, never waiting on close()', () => {
    for (const [response, expected] of [
      [0, 'retry'],
      [1, 'destroy'],
      [-1, 'destroy'],
    ] as const) {
      const calls: string[] = []
      applyCrashLoopChoice(response, {
        retry: () => calls.push('retry'),
        destroy: () => calls.push('destroy'),
      })
      assert.deepEqual(calls, [expected], `response ${String(response)}`)
    }
  })
})
