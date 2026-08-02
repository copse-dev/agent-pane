import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  startWindowAttention,
  type DockAttention,
  type WindowAttention,
} from './user-alerts-electron.ts'

function fakeWindow(): {
  win: WindowAttention
  flashes: boolean[]
  focus(): void
} {
  const flashes: boolean[] = []
  let focusListener: (() => void) | null = null
  return {
    flashes,
    win: {
      flashFrame: (flag) => flashes.push(flag),
      once: (_event, listener): void => {
        focusListener = listener
      },
      removeListener: (_event, listener): void => {
        if (focusListener === listener) focusListener = null
      },
      isDestroyed: () => false,
    },
    focus: () => focusListener?.(),
  }
}

describe('startWindowAttention', () => {
  it('uses a critical Dock bounce for interaction and stops it once', () => {
    const target = fakeWindow()
    const calls: string[] = []
    const dock: DockAttention = {
      bounce: (type) => {
        calls.push(`bounce:${String(type)}`)
        return 42
      },
      cancelBounce: (id) => calls.push(`cancel:${String(id)}`),
    }

    const stop = startWindowAttention(target.win, dock, 'interaction')
    stop()
    stop()

    assert.deepEqual(calls, ['bounce:critical', 'cancel:42'])
    assert.deepEqual(target.flashes, [])
  })

  it('uses an informational bounce for completion and stops on focus', () => {
    const target = fakeWindow()
    const calls: string[] = []
    const dock: DockAttention = {
      bounce: (type) => {
        calls.push(`bounce:${String(type)}`)
        return 7
      },
      cancelBounce: (id) => calls.push(`cancel:${String(id)}`),
    }

    startWindowAttention(target.win, dock, 'thread-finished')
    target.focus()

    assert.deepEqual(calls, ['bounce:informational', 'cancel:7'])
  })

  it('flashes the taskbar when no Dock is available and clears on focus', () => {
    const target = fakeWindow()

    startWindowAttention(target.win, undefined, 'interaction')
    target.focus()

    assert.deepEqual(target.flashes, [true, false])
  })
})
