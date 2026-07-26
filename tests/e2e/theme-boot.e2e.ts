import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedThemeBootFixture } from './helpers/seed-config.ts'
import { waitForImagesSettled } from './helpers/screenshot.ts'

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

  it('preserves the boot theme query when opening a popout', async () => {
    const mainHandle = (await browser.getWindowHandles())[0]
    expect(mainHandle).toBeDefined()
    const before = await browser.getWindowHandles()
    await browser.execute(() => window.api.panes.popout('explorer'))
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 20_000,
      timeoutMsg: 'popout window did not open',
    })
    const popoutHandle = (await browser.getWindowHandles()).find(
      (handle) => !before.includes(handle),
    )
    expect(popoutHandle).toBeDefined()
    await browser.switchToWindow(popoutHandle as string)

    const themeState = await browser.execute(() => ({
      htmlTheme: document.documentElement.dataset['theme'] ?? null,
      queryTheme: new URLSearchParams(window.location.search).get('t'),
      popoutMode: new URLSearchParams(window.location.search).get('popout'),
    }))
    expect(themeState).toEqual({ htmlTheme: 'light', queryTheme: 'light', popoutMode: 'explorer' })

    // The assertions above only need `documentElement`, which exists the moment
    // the window does — so without these waits the capture below races the
    // explorer's async render stages and commits whatever it happens to catch.
    // `.file-tree` is appended empty and filled from a directory read, so waiting
    // on it (or on images, of which an empty tree has none) still lands on a
    // blank pane; the row wait is what makes the capture wait for content.
    await $('#file-tree-host .file-tree').waitForDisplayed({ timeout: 30_000 })
    await $('#file-tree-host .tree-row').waitForExist({ timeout: 30_000 })
    await waitForImagesSettled('#file-tree-host', { minImages: 1 })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'theme-boot-popout-light.png'))

    await browser.closeWindow()
    await browser.switchToWindow(mainHandle as string)
  })
})
