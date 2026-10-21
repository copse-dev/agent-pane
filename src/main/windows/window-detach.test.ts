import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detachWindow,
  isWindowDetached,
  reattachWindow,
  shouldDetachOnClose,
} from './window-detach.ts'

test('only a macOS close during a running turn detaches', () => {
  assert.equal(shouldDetachOnClose({ platform: 'darwin', quitting: false, runningTurns: 1 }), true)
  assert.equal(shouldDetachOnClose({ platform: 'darwin', quitting: false, runningTurns: 0 }), false)
  // Quitting (Cmd+Q, the updater, an e2e teardown) still closes for real.
  assert.equal(shouldDetachOnClose({ platform: 'darwin', quitting: true, runningTurns: 1 }), false)
  assert.equal(shouldDetachOnClose({ platform: 'linux', quitting: false, runningTurns: 1 }), false)
  assert.equal(shouldDetachOnClose({ platform: 'win32', quitting: false, runningTurns: 1 }), false)
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
