import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detachWindow,
  isWindowDetached,
  reattachWindow,
  shouldDetachOnClose,
  shouldQuitDetachedApp,
} from './window-detach.ts'

test('a close during a running turn detaches on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.equal(shouldDetachOnClose({ platform, quitting: false, runningTurns: 1 }), true)
    assert.equal(shouldDetachOnClose({ platform, quitting: false, runningTurns: 0 }), false)
    // Quitting (Cmd+Q, the updater, an e2e teardown) still closes for real.
    assert.equal(shouldDetachOnClose({ platform, quitting: true, runningTurns: 1 }), false)
  }
})

test('outside macOS a detached app quits once nothing needs it', () => {
  const idle = { detached: true, runningTurns: 0, mobileCompanionEnabled: false }
  assert.equal(shouldQuitDetachedApp({ platform: 'linux', ...idle }), true)
  assert.equal(shouldQuitDetachedApp({ platform: 'win32', ...idle }), true)
  // The Dock keeps a macOS app reachable, so it stays.
  assert.equal(shouldQuitDetachedApp({ platform: 'darwin', ...idle }), false)
  assert.equal(shouldQuitDetachedApp({ platform: 'linux', ...idle, runningTurns: 1 }), false)
  assert.equal(shouldQuitDetachedApp({ platform: 'linux', ...idle, detached: false }), false)
  assert.equal(
    shouldQuitDetachedApp({
      platform: 'linux',
      ...idle,
      mobileCompanionEnabled: true,
    }),
    false,
  )
})

function fakeWindow(): {
  win: Parameters<typeof detachWindow>[0]
  calls: string[]
} {
  const calls: string[] = []
  const win: Parameters<typeof detachWindow>[0] = {
    hide: () => {
      calls.push('hide')
    },
    show: () => {
      calls.push('show')
    },
    focus: () => {
      calls.push('focus')
    },
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {
      calls.push('restore')
    },
    webContents: {
      setBackgroundThrottling: (enabled) => {
        calls.push(`throttling ${String(enabled)}`)
      },
      loadURL: async (url: string) => {
        calls.push(`load ${url}`)
      },
    },
  }
  return { win, calls }
}

test('detaching unloads the renderer once; reattaching reloads it before showing', async () => {
  const { win, calls } = fakeWindow()
  detachWindow(win)
  detachWindow(win)
  assert.deepEqual(calls, ['hide', 'load about:blank'])
  assert.equal(isWindowDetached(win), true)

  let reloads = 0
  reattachWindow(win, async () => {
    reloads += 1
  })
  assert.equal(reloads, 1)
  assert.equal(isWindowDetached(win), false)
  assert.deepEqual(calls.slice(2), ['show', 'focus'])

  // A window that was never detached is only brought forward.
  reattachWindow(win, async () => {
    reloads += 1
  })
  assert.equal(reloads, 1)
})

test('a hidden-window launch reloads without showing', () => {
  const { win, calls } = fakeWindow()
  detachWindow(win)
  reattachWindow(win, async () => undefined, { show: false })
  assert.deepEqual(calls, ['hide', 'load about:blank'])
  assert.equal(isWindowDetached(win), false)
})

test('Mobile Companion retains an idle or working window on every platform, but never traps Quit', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const runningTurns of [0, 1]) {
      assert.equal(
        shouldDetachOnClose({
          platform,
          runningTurns,
          quitting: false,
          mobileCompanionEnabled: true,
        }),
        true,
      )
      assert.equal(
        shouldDetachOnClose({
          platform,
          runningTurns,
          quitting: true,
          mobileCompanionEnabled: true,
        }),
        false,
      )
    }
  }
})

test('mobile close retains the sole renderer and reopening does not reload or duplicate it', () => {
  const { win, calls } = fakeWindow()
  detachWindow(win, { keepRenderer: true })
  detachWindow(win, { keepRenderer: true })
  assert.equal(isWindowDetached(win), true)
  assert.deepEqual(calls, ['hide', 'throttling false'])
  reattachWindow(win, async () => {
    throw new Error('Must not reload the mobile owner')
  })
  assert.equal(isWindowDetached(win), false)
  assert.deepEqual(calls, ['hide', 'throttling false', 'throttling true', 'show', 'focus'])
})
