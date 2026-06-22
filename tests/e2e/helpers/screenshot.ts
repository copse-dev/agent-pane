import { join } from 'node:path'
import { browser } from '@wdio/globals'

/** Fixed viewport for committed e2e reference screenshots (see tests/e2e/screenshots/). */
export const E2E_VIEWPORT = { width: 1280, height: 800 } as const

export const E2E_SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

/** Pin the app shell to a fixed size and settle layout before capturing. */
export async function prepareE2eScreenshot(): Promise<void> {
  await browser.execute((size) => {
    const app = document.getElementById('app')
    if (!app) return
    app.style.width = `${size.width}px`
    app.style.height = `${size.height}px`
    app.style.overflow = 'hidden'
    app.style.boxSizing = 'border-box'
    window.dispatchEvent(new Event('resize'))
  }, E2E_VIEWPORT)
  await browser.pause(100)
}

/** Capture the app shell at the fixed viewport (excludes OS chrome). */
export async function saveAppScreenshot(filename: string): Promise<void> {
  await prepareE2eScreenshot()
  const app = await browser.$('#app')
  await app.waitForDisplayed({ timeout: 15_000 })
  await app.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/** Capture a single element after pinning the viewport (footer, input bar, etc.). */
export async function saveElementScreenshot(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot()
  const el = await browser.$(selector)
  await el.waitForDisplayed({ timeout: 15_000 })
  await el.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}
