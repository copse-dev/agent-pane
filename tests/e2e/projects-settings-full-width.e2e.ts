import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('Settings footer button', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-footer-width')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('fills the sidebar footer and opens Settings from its left edge', async () => {
    const button = await $('.projects-settings-btn')
    await button.waitForDisplayed({ timeout: 30_000 })
    await expect(button).toHaveText('Settings')

    const span = await browser.execute(() => {
      const actions = document.querySelector('.projects-settings-actions')!.getBoundingClientRect()
      const settings = document.querySelector<HTMLElement>('.projects-settings-btn')!
      const rect = settings.getBoundingClientRect()
      const middle = rect.top + rect.height / 2
      return {
        leftGap: rect.left - actions.left,
        rightGap: actions.right - rect.right,
        ownsLeftEdge: settings.contains(document.elementFromPoint(actions.left + 1, middle)),
        ownsRightEdge: settings.contains(document.elementFromPoint(actions.right - 1, middle)),
      }
    })
    expect(Math.abs(span.leftGap)).toBeLessThanOrEqual(1)
    expect(Math.abs(span.rightGap)).toBeLessThanOrEqual(1)
    expect(span.ownsLeftEdge).toBe(true)
    expect(span.ownsRightEdge).toBe(true)

    await button.moveTo()
    await saveElementScreenshot(
      '.projects-settings-actions',
      'projects-settings-full-width-hover.png',
    )

    await browser.execute(() => {
      const actions = document.querySelector('.projects-settings-actions')!.getBoundingClientRect()
      const target = document.elementFromPoint(actions.left + 1, actions.top + actions.height / 2)
      if (!(target instanceof HTMLElement)) throw new Error('Settings left edge has no hit target')
      target.click()
    })
    await expect($('#settings-dialog')).toBeDisplayed()
  })
})
