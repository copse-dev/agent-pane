import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bindTitlebarCompactLayout, TITLEBAR_COMPACT_CLASS } from './titlebar-compact.ts'

describe('titlebar compact layout', () => {
  it('compacts on overflow and expands when the full controls fit again', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const originalResizeObserver = globalThis.ResizeObserver

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        void callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
    globalThis.cancelAnimationFrame = (): void => {}
    globalThis.ResizeObserver = TestResizeObserver

    const titlebar = document.createElement('div')
    const left = document.createElement('div')
    const controls = document.createElement('div')
    titlebar.append(left, controls)
    document.body.append(titlebar)

    let availableWidth = 500
    Object.defineProperties(titlebar, {
      clientWidth: { configurable: true, get: () => availableWidth },
      scrollWidth: {
        configurable: true,
        get: () => (titlebar.classList.contains(TITLEBAR_COMPACT_CLASS) ? 400 : 600),
      },
    })

    let destroy: (() => void) | undefined
    try {
      destroy = bindTitlebarCompactLayout(titlebar, [left, controls])
      assert.equal(titlebar.classList.contains(TITLEBAR_COMPACT_CLASS), true)

      availableWidth = 700
      window.dispatchEvent(new Event('resize'))
      assert.equal(titlebar.classList.contains(TITLEBAR_COMPACT_CLASS), false)
    } finally {
      destroy?.()
      titlebar.remove()
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
