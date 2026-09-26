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

  it('goes compact when a control fills in without the footer itself resizing', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const originalResizeObserver = globalThis.ResizeObserver

    const observed: Element[] = []
    let notify: (() => void) | undefined
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = (): void => {
          callback([], this)
        }
      }
      observe(target: Element): void {
        observed.push(target)
      }
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
    footer.className = 'input-footer'
    const branchHost = document.createElement('div')
    branchHost.className = 'footer-branch-host'
    footer.append(branchHost)
    document.body.append(footer)

    // The footer keeps its width; only its content grows once the branch loads.
    let contentWidth = 200
    Object.defineProperties(footer, {
      clientWidth: { configurable: true, get: () => 220 },
      scrollWidth: { configurable: true, get: () => contentWidth },
    })

    let binding: ReturnType<typeof bindFooterCompactLayout> | undefined
    try {
      binding = bindFooterCompactLayout(footer)
      assert.equal(binding.isCompact(), false)
      assert.ok(observed.includes(branchHost), 'footer controls must be observed')

      contentWidth = 300
      notify?.()
      assert.equal(binding.isCompact(), true)
    } finally {
      binding?.destroy()
      footer.remove()
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
