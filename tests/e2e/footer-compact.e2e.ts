import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedFooterCompactFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function setChatPaneWidth(px: number): Promise<void> {
  await browser.execute((width) => {
    const pane = document.getElementById('pane-chat')
    const inputBar = document.getElementById('input-bar')
    if (pane) {
      pane.style.flex = '0 0 auto'
      pane.style.width = `${width}px`
      pane.style.maxWidth = `${width}px`
    }
    if (inputBar) {
      inputBar.style.width = `${width}px`
      inputBar.style.maxWidth = `${width}px`
    }
    window.dispatchEvent(new Event('resize'))
  }, px)
  await browser.waitUntil(
    async () => {
      const info = await browser.execute(() => {
        const footer = document.querySelector('.input-footer')
        if (!footer) return null
        return {
          width: footer.clientWidth,
          compact: footer.classList.contains('is-compact'),
        }
      })
      if (!info) return false
      if (px >= 600) return info.width >= 600 && !info.compact
      return info.width <= px + 4
    },
    { timeout: 30_000, interval: 100 },
  )
}

describe('footer compact layout', () => {
  let seed: ReturnType<typeof seedFooterCompactFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  beforeEach(async () => {
    resetUserData()
    seed = seedFooterCompactFixture(process.cwd())
    seedE2eViewport()
    await browser.reloadSession()
    await $('.input-footer').waitForExist({ timeout: 30_000 })
  })

  afterEach(() => {
    resetUserData()
  })

  it('shows export and token count when the footer is wide enough', async () => {
    await setChatPaneWidth(720)

    await browser.waitUntil(
      async () => !(await (await $('.input-footer')).getAttribute('class'))?.includes('is-compact'),
      { timeout: 30_000, timeoutMsg: 'expected wide footer layout' },
    )

    await expect($('.footer-export')).toBeDisplayed()
    await expect($('.footer-overflow')).not.toBeDisplayed()
    await expect($('.footer-usage')).toHaveText(seed.tokenLabel)

    const footer = await $('.input-footer')
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'footer-compact-wide.png'))
  })

  it('collapses export and tokens when the footer is cramped', async () => {
    await setChatPaneWidth(360)

    await browser.waitUntil(
      async () => (await (await $('.input-footer')).getAttribute('class'))?.includes('is-compact'),
      { timeout: 30_000, timeoutMsg: 'expected compact footer layout' },
    )

    await expect($('.footer-export')).not.toBeDisplayed()
    await expect($('.footer-overflow')).toBeDisplayed()
    await expect($('.footer-usage')).not.toBeDisplayed()

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()
    const title = await wheel.getAttribute('title')
    expect(title).toContain(seed.tokenLabel)
    expect(title).toContain('%')

    const footer = await $('.input-footer')
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'footer-compact-narrow.png'))

    await (await $('.footer-overflow-trigger')).click()
    await expect($('.footer-overflow-menu')).toBeDisplayed()
    await expect($('.footer-overflow-item')).toHaveText('Export')
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'footer-compact-overflow-open.png'))
  })
})
