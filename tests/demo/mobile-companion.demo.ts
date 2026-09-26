import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'

describe('Mobile Companion at phone width', () => {
  it('shows pairing, attention groups, and escaped completed output in both themes', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.url('/mobile/')
    expect(await browser.execute(() => window.innerWidth)).toBe(390)
    await expect($('#pair h1')).toHaveText('See what needs you.')
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'mobile-companion-pair-dark.png'))

    await browser.execute(() => localStorage.setItem('copse-mobile-token', 'visual-test-token'))
    await browser.refresh()
    await expect($('.group .row')).toBeDisplayed()
    await expect($('#groups')).toHaveText(expect.stringContaining('NEEDS YOU'))
    await expect($('#groups')).toHaveText(expect.stringContaining('WORKING'))
    await expect($('#groups')).toHaveText(expect.stringContaining('RECENT'))
    const overflow = await browser.execute(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    expect(overflow).toBe(false)
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'mobile-companion-activity-dark.png'))

    await browser.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'mobile-companion-activity-light.png'))
    await $('.group .row').click()
    await expect($('#thread-title')).toHaveText('Review the release')
    await expect($('#messages')).toHaveText(
      expect.stringContaining('</p><img src=x onerror=alert(1)>'),
    )
    expect(await browser.execute(() => document.querySelectorAll('#messages img').length)).toBe(0)
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'mobile-companion-thread-light.png'))
  })
})
