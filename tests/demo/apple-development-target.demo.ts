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

  it('spaces the panel from tokens, so the interface scale reaches it', async () => {
    // Before #3065 the panel used raw 4-12px gaps and 11-12px type, so
    // Settings -> Appearance -> Interface scale left it at its 1x size.
    const read = () =>
      browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('.apple-development-panel')
        const status = panel?.querySelector<HTMLElement>('.apple-development-status')
        if (!panel || !status) return null
        const style = getComputedStyle(panel)
        return {
          gap: Number.parseFloat(style.rowGap),
          paddingTop: Number.parseFloat(style.paddingTop),
          paddingLeft: Number.parseFloat(style.paddingLeft),
          statusSize: Number.parseFloat(getComputedStyle(status).fontSize),
          tokens: {
            sm: Number.parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue('--spacing-sm'),
            ),
          },
        }
      })
    const base = await read()
    expect(base).not.toBeNull()
    if (!base) return
    await browser.execute(() => {
      document.documentElement.style.setProperty('--ui-scale', '1.25')
    })
    const scaled = await read()
    await browser.execute(() => {
      document.documentElement.style.removeProperty('--ui-scale')
    })
    expect(scaled).not.toBeNull()
    if (!scaled) return
    for (const key of ['gap', 'paddingTop', 'paddingLeft', 'statusSize'] as const) {
      expect(scaled[key]).toBeCloseTo(base[key] * 1.25, 1)
    }
  })
})
