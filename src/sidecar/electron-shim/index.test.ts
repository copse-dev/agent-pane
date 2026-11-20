import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserWindow, shell } from './index.ts'

describe('electron shim BrowserWindow', () => {
  it("emits the web contents' destroyed event once when the window goes away", () => {
    const win = new BrowserWindow({ show: false })
    let destroyed = 0
    win.webContents.once('destroyed', () => {
      destroyed += 1
    })
    win.webContents.on('destroyed', () => {
      destroyed += 1
    })
    win.destroy()
    win.destroy()
    assert.equal(destroyed, 2)
    assert.equal(win.webContents.isDestroyed(), true)
  })
})

describe('electron shim shell', () => {
  it('survives a missing system opener', async () => {
    const path = process.env['PATH']
    process.env['PATH'] = '/copse-test-no-such-directory'
    try {
      await shell.openExternal('https://example.invalid/')
      // The spawn failure arrives as an asynchronous `error` event; unhandled,
      // it is an uncaught exception and fails this test.
      await delay(200)
    } finally {
      if (path === undefined) delete process.env['PATH']
      else process.env['PATH'] = path
    }
  })
})
