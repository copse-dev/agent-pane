import { $, $$, browser, expect } from '@wdio/globals'
import { FOOTER_COMPACT_EXPECTATIONS } from '@shared/demo-scenarios.ts'
import { saveAppScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function setChatPaneWidth(width: number): Promise<void> {
  await browser.execute((nextWidth) => {
    const pane = document.getElementById('pane-chat')
    const inputBar = document.getElementById('input-bar')
    for (const element of [pane, inputBar]) {
      if (!element) continue
      element.style.flex = '0 0 auto'
      element.style.width = `${nextWidth}px`
      element.style.maxWidth = `${nextWidth}px`
    }
    window.dispatchEvent(new Event('resize'))
  }, width)
  await browser.waitUntil(
    async () => {
      const layout = await browser.execute(() => {
        const footer = document.querySelector('.input-footer')
        if (!footer) return null
        return {
          width: footer.clientWidth,
          compact: footer.classList.contains('is-compact'),
        }
      })
      if (!layout) return false
      if (width >= 600) return layout.width >= 600 && !layout.compact
      return layout.width <= width + 4
    },
    { timeoutMsg: `expected footer to settle at ${String(width)}px` },
  )
}

describe('browser-hosted footer geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=footer-compact')
    await $('.input-footer').waitForExist()
  })

  it('shows overflow actions and token usage at wide widths', async () => {
    await setChatPaneWidth(720)

    await expect($('.footer-overflow')).toBeDisplayed()
    await expect($('.footer-usage')).toHaveText(FOOTER_COMPACT_EXPECTATIONS.tokenLabel)

    await $('.footer-overflow-trigger').click()
    await expect($('.footer-overflow-menu')).toBeDisplayed()
    const items = await $$('.footer-overflow-item')
    await expect(items).toBeElementsArrayOfSize(5)
    await expect(items[0]).toHaveText('Enable Guarded YOLO')
    await expect(items[1]).toHaveText('Copy thread ID')
    await expect(items[2]).toHaveText('Export conversation (JSONL)')
    await expect(items[3]).toHaveText('Export thread folder (ZIP)')
    await expect(items[4]).toHaveText('Share trace')

    await saveElementScreenshot('.input-footer', 'footer-compact-wide.png')
  })

  it('collapses secondary actions while preserving context at narrow widths', async () => {
    await setChatPaneWidth(360)
    await browser.waitUntil(
      async () => (await $('.input-footer').getAttribute('class'))?.includes('is-compact'),
      { timeoutMsg: 'expected compact footer layout in browser-hosted renderer' },
    )

    await expect($('.footer-overflow')).toBeDisplayed()
    await expect($('.footer-usage')).not.toBeDisplayed()

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()
    const title = await wheel.getAttribute('title')
    expect(title).toContain(FOOTER_COMPACT_EXPECTATIONS.tokenLabel)
    expect(title).toContain('%')

    await saveElementScreenshot('.input-footer', 'footer-compact-narrow.png')

    await $('.footer-overflow-trigger').click()
    await expect($('.footer-overflow-menu')).toBeDisplayed()
    const items = await $$('.footer-overflow-item')
    await expect(items).toBeElementsArrayOfSize(5)
    await expect(items[0]).toHaveText('Enable Guarded YOLO')
    await expect(items[1]).toHaveText('Copy thread ID')
    await expect(items[2]).toHaveText('Export conversation (JSONL)')
    await expect(items[3]).toHaveText('Export thread folder (ZIP)')
    await expect(items[4]).toHaveText('Share trace')
    await saveAppScreenshot('footer-compact-overflow-open.png')
  })
})
