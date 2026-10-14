import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import {
  parkPointer,
  prepareE2eScreenshot,
  savePreparedAppScreenshot,
  waitForSettledLayout,
  withCaptureFrame,
} from './screenshot.ts'

/** Capture the long section in overlapping scroll views, including its first and last controls. */
export async function saveSettingsSection(selector: string, filename: string): Promise<void> {
  await withCaptureFrame(() => captureSettingsSection(selector, filename))
}

async function captureSettingsSection(selector: string, filename: string): Promise<void> {
  const positions = await browser.execute((sel) => {
    const result: number[][] = []
    for (
      let parent = document.querySelector(sel)?.parentElement;
      parent;
      parent = parent.parentElement
    )
      result.push([parent.scrollLeft, parent.scrollTop])
    return result
  }, selector)
  try {
    await prepareE2eScreenshot()
    const section = $(selector)
    await section.scrollIntoView({ block: 'start' })
    await browser.execute((sel) => {
      const section = document.querySelector(sel)!
      for (let parent = section.parentElement; parent; parent = parent.parentElement) {
        if (
          parent.scrollHeight > parent.clientHeight &&
          /auto|scroll/.test(getComputedStyle(parent).overflowY)
        ) {
          parent.scrollTop +=
            section.getBoundingClientRect().top -
            Math.max(parent.getBoundingClientRect().top, 40) -
            8
          return
        }
      }
    }, selector)
    let covered = 0
    for (let page = 0; page < 8; page++) {
      await waitForSettledLayout(selector)
      const bounds = await browser.execute((sel) => {
        const section = document.querySelector(sel)!
        const rect = section.getBoundingClientRect()
        const scroll = section.closest('.settings-content')!
        const viewport = scroll.getBoundingClientRect()
        // Settings is fixed to the native window, which can be taller than the
        // app element cropped by savePreparedAppScreenshot (e.g. automation).
        const frame = document.getElementById('app')!.getBoundingClientRect()
        const footer = document.querySelector('.settings-buttons')?.getBoundingClientRect()
        const footerTop = footer && footer.height > 0 ? footer.top - 12 : viewport.bottom
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          visibleTop: Math.max(viewport.top, frame.top, 40),
          visibleBottom: Math.min(viewport.bottom, footerTop, frame.bottom),
        }
      }, selector)
      const start = Math.max(0, bounds.visibleTop - bounds.top)
      const end = Math.min(bounds.height, bounds.visibleBottom - bounds.top)
      assert.ok(
        start <= covered + 1,
        `scroll captures must cover the section without a gap: ${JSON.stringify({ page, covered, bounds })}`,
      )
      assert.ok(end > covered, 'scroll capture must make progress')
      await parkPointer()
      await savePreparedAppScreenshot(
        page === 0 ? filename : filename.replace('.png', `-page-${page + 1}.png`),
      )
      covered = end
      if (bounds.bottom <= bounds.visibleBottom) return
      await browser.execute(
        ({ sel, distance }) => {
          const section = document.querySelector(sel)!
          for (let parent = section.parentElement; parent; parent = parent.parentElement) {
            if (
              parent.scrollHeight > parent.clientHeight &&
              /auto|scroll/.test(getComputedStyle(parent).overflowY)
            ) {
              parent.scrollTop += distance
              return
            }
          }
          throw new Error('settings scrollport missing')
        },
        { sel: selector, distance: bounds.visibleBottom - bounds.visibleTop - 80 },
      )
    }
    throw new Error('settings section exceeds capture page limit')
  } finally {
    await browser.execute(
      ({ sel, positions }) => {
        let index = 0
        for (
          let parent = document.querySelector(sel)?.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const position = positions[index++]
          if (position) {
            parent.scrollLeft = position[0] ?? 0
            parent.scrollTop = position[1] ?? 0
          }
        }
      },
      { sel: selector, positions },
    )
  }
}
