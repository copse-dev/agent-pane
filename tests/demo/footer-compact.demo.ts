import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

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
}

describe('browser demo footer geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=footer-compact')
    await $('.input-footer').waitForExist()
  })

  it('uses the real compact footer layout without Electron', async () => {
    await setChatPaneWidth(360)
    await browser.waitUntil(
      async () => (await $('.input-footer').getAttribute('class'))?.includes('is-compact'),
      { timeoutMsg: 'expected compact footer layout in browser demo' },
    )

    await expect($('.footer-export')).not.toBeDisplayed()
    await expect($('.footer-overflow')).toBeDisplayed()
    await expect($('.footer-usage')).not.toBeDisplayed()
    await expect($('.context-wheel')).toBeDisplayed()

    await saveElementScreenshot('.input-footer', 'demo-spike-footer-compact.png')
  })
})
