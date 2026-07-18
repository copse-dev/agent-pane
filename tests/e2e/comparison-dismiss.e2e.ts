import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedComparisonErrorFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for dismissing a failed model comparison: the error card renders
// with both a Retry and a dismiss (×) action in its header; clicking dismiss
// removes the card, and the removal is persisted so the card stays gone after
// an app restart. Component tests cover the DOM shape and store mutation; this
// spec proves the click-through and the on-disk persistence in the real
// Electron renderer, with screenshots of the before/after states.
describe('dismissing a failed model comparison', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedComparisonErrorFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows retry and dismiss actions on the failed card, then dismisses it', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    const card = $('.messages-list [data-comparison-card][data-status="error"]')
    await card.waitForExist({ timeout: 30_000 })

    // NOTE: the returned object must not have a truthy `error` key — webdriver
    // v9 treats a 200 execute response whose value carries `error` as a failed
    // WebDriver request and throws that string (retrying the call three times).
    const header = await browser.execute(() => {
      const failed = document.querySelector('[data-comparison-card]')
      return {
        title: failed?.querySelector('.comparison-panel-title')?.textContent ?? '',
        errorText: failed?.querySelector('.comparison-panel-error')?.textContent ?? '',
        hasRetry: !!failed?.querySelector('.card-retry-button'),
        hasDismiss: !!failed?.querySelector('.card-dismiss-button'),
      }
    })
    expect(header.title).toBe('Comparison failed')
    expect(header.errorText).toContain('spend approval declined')
    expect(header.hasRetry).toBe(true)
    expect(header.hasDismiss).toBe(true)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'comparison-dismiss-before.png'))

    await $('[data-comparison-card] .card-dismiss-button').click()
    await card.waitForExist({ timeout: 10_000, reverse: true })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'comparison-dismiss-after.png'))
  })

  it('keeps the comparison dismissed after an app restart', async () => {
    // The dismissal autosave is debounced (250ms); give it a moment to land in
    // the thread store before restarting the app.
    await browser.pause(1_000)
    await browser.reloadSession()

    await $('.messages-list').waitForExist({ timeout: 30_000 })
    // The seeded transcript is back...
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })
    // ...but the dismissed comparison card is not.
    const cardExists = await $('[data-comparison-card]').isExisting()
    expect(cardExists).toBe(false)
  })
})
