import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedThemeBootFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for #41: persisted light theme must apply before async boot() so
// the window does not flash the dark :root defaults on launch.
describe('theme boot before first paint (#41)', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    seedThemeBootFixture(process.cwd(), 'light')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('applies the saved light theme from theme-boot.js before boot()', async () => {
    await $('#app').waitForExist({ timeout: 30_000 })

    const themeState = await browser.execute(() => ({
      htmlTheme: document.documentElement.dataset['theme'] ?? null,
      queryTheme: new URLSearchParams(window.location.search).get('t'),
    }))

    expect(themeState.queryTheme).toBe('light')
    expect(themeState.htmlTheme).toBe('light')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'theme-boot-light.png'))
  })
})
