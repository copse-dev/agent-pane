import { mkdirSync } from 'node:fs'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

interface MultiWindowBridge {
  createMainWindow(): Promise<void>
}

describe('multiple main windows', function () {
  this.timeout(90_000)
  let primaryHandle: string | undefined
  let secondaryHandle: string | undefined

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-multiple-main-windows', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
    await $('#app').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('opens a second complete Copse window', async () => {
    primaryHandle = (await browser.getWindowHandles())[0]
    if (!primaryHandle) throw new Error('Main window handle unavailable')
    const mainHandle = primaryHandle

    const before = await browser.getWindowHandles()
    await browser.execute(async () => {
      const bridge = (window as unknown as { __copseE2e?: MultiWindowBridge }).__copseE2e
      if (!bridge?.createMainWindow) {
        throw new Error('__copseE2e.createMainWindow unavailable')
      }
      await bridge.createMainWindow()
    })

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'Second main window did not open',
    })
    secondaryHandle = (await browser.getWindowHandles()).find((handle) => !before.includes(handle))
    if (!secondaryHandle) throw new Error('Secondary window handle unavailable')

    await browser.switchToWindow(secondaryHandle)
    await $('#app').waitForDisplayed({ timeout: 30_000 })
    await $('#pane-projects').waitForExist({ timeout: 30_000 })
    await $('#pane-chat').waitForExist({ timeout: 30_000 })
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await saveAppScreenshot('multiple-main-windows-secondary.png')

    await browser.switchToWindow(mainHandle)
    await $('#app').waitForDisplayed({ timeout: 10_000 })
    await expect(await browser.getWindowHandles()).toContain(mainHandle)
  })
})
