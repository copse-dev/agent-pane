import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelChatFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'

describe('PR pane pop-out (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedPrPanelChatFixture(process.cwd())
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(async () => {
    // Leave WDIO on the main window so session teardown / toast assertions run
    // against it even if the test bailed mid-pop-out.
    const handles = await browser.getWindowHandles()
    if (handles[0]) await browser.switchToWindow(handles[0])
    resetUserData()
  })

  async function openPrTab(): Promise<void> {
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()
  }

  it('detaches the PR pane into its own window with live data', async function () {
    this.timeout(120_000)

    await openPrTab()
    await browser.waitUntil(async () => (await $$('.pr-list-row')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'expected the docked PR list to load before popping out',
    })

    const mainHandle = (await browser.getWindowHandles())[0]
    const before = await browser.getWindowHandles()

    // Click "Pop out" — a brand-new OS window should appear.
    await $('[aria-label="Pop out pull requests"]').click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'expected a new pop-out window to open',
    })

    const after = await browser.getWindowHandles()
    const popoutHandle = after.find((h) => !before.includes(h))
    expect(popoutHandle).toBeDefined()

    // The new window renders the real PR pane (same mock-backed data), and the
    // app chrome (projects sidebar, chat, titlebar) is collapsed away.
    await browser.switchToWindow(popoutHandle as string)
    await $('.pr-list-body').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.pr-list-row')).length >= 2, {
      timeout: 30_000,
      timeoutMsg: 'expected the popped-out PR list to load its own data',
    })
    await expect(await $('.git-changes-section-title*=From chat')).toBeDisplayed()
    await expect(await $('#pane-projects')).not.toBeDisplayed()
    await expect(await $('#pane-chat')).not.toBeDisplayed()
    await expect(await $('#titlebar')).not.toBeDisplayed()
    // The detached window does not offer to pop out again.
    await expect(await $('.pr-pane-popout-btn')).not.toBeDisplayed()

    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'pr-pane-popout-window.png'))

    // The main window keeps its full three-pane layout.
    await browser.switchToWindow(mainHandle)
    await expect(await $('#pane-projects')).toBeDisplayed()
    await expect(await $('.prompt-input')).toBeExisting()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'pr-pane-popout-main.png'))
  })
})
