import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bindFooterCompactLayout } from './footer-compact.ts'

describe('footer compact layout', () => {
  it('measures hidden usage without removing an already-compact footer class', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const originalResizeObserver = globalThis.ResizeObserver

    class TestResizeObserver {
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

    const footer = document.createElement('div')
    footer.className = 'input-footer is-compact'
    const usage = document.createElement('span')
    usage.className = 'footer-usage'
    footer.append(usage)
    document.body.append(footer)

    let measuredWithoutCompact = false
    let usageDisplayDuringMeasurement = ''
    Object.defineProperties(footer, {
      clientWidth: { configurable: true, get: () => 220 },
      scrollWidth: {
        configurable: true,
        get: () => {
          measuredWithoutCompact ||= !footer.classList.contains('is-compact')
          usageDisplayDuringMeasurement = usage.style.display
          return 300
        },
      },
    })

    let binding: ReturnType<typeof bindFooterCompactLayout> | undefined
    try {
      binding = bindFooterCompactLayout(footer)

      assert.equal(binding.isCompact(), true)
      assert.equal(measuredWithoutCompact, false)
      assert.equal(usageDisplayDuringMeasurement, 'inline')
      assert.equal(usage.style.display, '')
    } finally {
      binding?.destroy()
      footer.remove()
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
