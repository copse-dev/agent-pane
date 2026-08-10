import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  appWindowCountForTest,
  broadcastToAppWindows,
  registerAppWindow,
  resetAppWindowsForTest,
  type AppWindowWebContents,
} from './app-window-broadcast.ts'

interface FakeWindow extends AppWindowWebContents {
  sent: { channel: string; args: unknown[] }[]
  destroy(): void
}

function fakeWindow(): FakeWindow {
  let destroyed = false
  return {
    sent: [],
    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    },
    isDestroyed: () => destroyed,
    destroy(): void {
      destroyed = true
    },
  }
}

afterEach(() => {
  resetAppWindowsForTest()
})

describe('app window broadcast', () => {
  it('reaches every registered window, not just the first', () => {
    // #1704: the diff queue used to push to the main window only, so a pane
    // pop-out never learned there were proposed changes at all.
    const main = fakeWindow()
    const popout = fakeWindow()
    registerAppWindow(main)
    registerAppWindow(popout)

    broadcastToAppWindows('diff:queued', 'project-1', 'thread-1', [{ path: 'a.ts' }])

    for (const win of [main, popout]) {
      assert.deepEqual(win.sent, [
        { channel: 'diff:queued', args: ['project-1', 'thread-1', [{ path: 'a.ts' }]] },
      ])
    }
  })

  it('stops sending to a window once it unregisters', () => {
    const main = fakeWindow()
    const popout = fakeWindow()
    registerAppWindow(main)
    const unregister = registerAppWindow(popout)

    unregister()
    broadcastToAppWindows('fs:changed')

    assert.equal(main.sent.length, 1)
    assert.equal(popout.sent.length, 0, 'closed pop-out must not be sent to')
  })

  it('prunes a window destroyed without its close handler running', () => {
    // App shutdown can tear a window down without `closed` firing; `send` on a
    // destroyed webContents throws in Electron, which would abort the fan-out
    // and starve every window after it.
    const dead = fakeWindow()
    const live = fakeWindow()
    registerAppWindow(dead)
    registerAppWindow(live)
    dead.destroy()

    broadcastToAppWindows('diff:conflict')

    assert.equal(dead.sent.length, 0)
    assert.equal(live.sent.length, 1, 'a dead window must not block the ones behind it')
    assert.equal(appWindowCountForTest(), 1, 'the dead window is dropped from the set')
  })

  it('is a no-op with no windows registered', () => {
    assert.doesNotThrow(() => {
      broadcastToAppWindows('diff:queued')
    })
  })
})
