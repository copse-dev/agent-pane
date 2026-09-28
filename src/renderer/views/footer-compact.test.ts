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

  it('re-measures when a label changes text while every box keeps its size', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const originalResizeObserver = globalThis.ResizeObserver

    // A faithful ResizeObserver fake for this case: no box resizes, so it
    // never fires. Only the DOM change can trigger the re-measure.
    class SilentResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    let frames = 0
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames += 1
      callback(0)
      return frames
    }
    globalThis.cancelAnimationFrame = (): void => {}
    globalThis.ResizeObserver = SilentResizeObserver

    const footer = document.createElement('div')
    footer.className = 'input-footer'
    const branchHost = document.createElement('div')
    branchHost.className = 'footer-branch-host'
    const label = document.createElement('span')
    label.className = 'branch-picker-label'
    const wrap = document.createElement('div')
    wrap.className = 'branch-picker'
    wrap.hidden = true
    wrap.append(label)
    branchHost.append(wrap)
    footer.append(branchHost)
    document.body.append(footer)

    // The footer's box is fixed by the composer; its natural width is the
    // other controls plus the label's text, once the picker is shown.
    Object.defineProperties(footer, {
      clientWidth: { configurable: true, get: () => 220 },
      scrollWidth: {
        configurable: true,
        get: () => 180 + (wrap.hidden ? 0 : label.textContent.length * 8),
      },
    })
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    let binding: ReturnType<typeof bindFooterCompactLayout> | undefined
    try {
      binding = bindFooterCompactLayout(footer)
      assert.equal(binding.isCompact(), false)

      // Revealing the picker (a `hidden` change) with a short name still fits.
      label.textContent = 'work'
      wrap.hidden = false
      await settle()
      assert.equal(binding.isCompact(), false)

      // The branch name arrives: text only, no box resize.
      label.textContent = 'feature/long-branch-name'
      await settle()
      assert.equal(binding.isCompact(), true)

      // Editing the existing text node (characterData) back to a short name.
      const text = label.firstChild
      assert.ok(text)
      text.nodeValue = 'main'
      await settle()
      assert.equal(binding.isCompact(), false)

      // After destroy, DOM changes no longer re-measure.
      binding.destroy()
      const framesAfterDestroy = frames
      label.textContent = 'feature/long-branch-name'
      await settle()
      assert.equal(frames, framesAfterDestroy)
    } finally {
      binding?.destroy()
      footer.remove()
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
