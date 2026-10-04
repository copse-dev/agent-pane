import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { openProjectManager } from './helpers/project-manager.ts'
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

  it('splits the default sidebar footer between Projects and Settings edge to edge', async () => {
    await $('.thread-browser .projects-settings-btn').waitForDisplayed({ timeout: 30_000 })
    const footer = await browser.execute(() => {
      const actions = document
        .querySelector('.thread-browser .projects-settings-actions')!
        .getBoundingClientRect()
      const manage = document.querySelector('.thread-browser .thread-browser-manage')!
      const settings = document.querySelector('.thread-browser .projects-settings-btn')!
      const middle = actions.top + actions.height / 2
      return {
        leftGap: manage.getBoundingClientRect().left - actions.left,
        rightGap: actions.right - settings.getBoundingClientRect().right,
        widths: [manage, settings].map((node) => node.getBoundingClientRect().width),
        ownsLeftEdge: manage.contains(document.elementFromPoint(actions.left + 1, middle)),
        ownsRightEdge: settings.contains(document.elementFromPoint(actions.right - 1, middle)),
      }
    })
    expect(Math.abs(footer.leftGap)).toBeLessThanOrEqual(1)
    expect(Math.abs(footer.rightGap)).toBeLessThanOrEqual(1)
    expect(Math.abs(footer.widths[0]! - footer.widths[1]!)).toBeLessThanOrEqual(1)
    expect(footer.ownsLeftEdge).toBe(true)
    expect(footer.ownsRightEdge).toBe(true)
  })

  it('fills the sidebar footer and opens Settings from its left edge', async () => {
    // Settings alone fills the project manager's footer.
    await openProjectManager()
    const button = await $('.thread-project-manager .projects-settings-btn')
    await button.waitForDisplayed({ timeout: 30_000 })
    await expect(button).toHaveText('Settings')

    const span = await browser.execute(() => {
      const actions = document
        .querySelector('.thread-project-manager .projects-settings-actions')!
        .getBoundingClientRect()
      const settings = document.querySelector<HTMLElement>(
        '.thread-project-manager .projects-settings-btn',
      )!
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
      '.thread-project-manager .projects-settings-actions',
      'projects-settings-full-width-hover.png',
    )

    await browser.execute(() => {
      const actions = document
        .querySelector('.thread-project-manager .projects-settings-actions')!
        .getBoundingClientRect()
      const target = document.elementFromPoint(actions.left + 1, actions.top + actions.height / 2)
      if (!(target instanceof HTMLElement)) throw new Error('Settings left edge has no hit target')
      target.click()
    })
    await expect($('#settings-dialog')).toBeDisplayed()
  })
})
