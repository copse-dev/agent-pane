import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted Apple Development target picker', () => {
  it('shows the compatible simulator choice in the compact target panel', async () => {
    await browser.url('/?scenario=apple-development')
    const panel = $('.apple-development-panel[data-plugin-id="copse.apple-development"]')
    await panel.waitForDisplayed()

    const picker = panel.$('.apple-development-target-picker')
    await picker.$('summary').click()
    const destination = picker.$('[aria-label="Destination"]')
    await expect(destination).toBeEnabled()
    await expect(destination).toHaveValue('platform=iOS Simulator,id=E2E-IP17-PRO')
    await expect(destination.$$('option')).toBeElementsArrayOfSize(1)
    await expect(destination.$('option')).toHaveText('iPhone 17 Pro · iOS Simulator')

    await saveElementScreenshot(
      '.apple-development-panel',
      'apple-development-compatible-target.png',
    )
  })
})
