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

// Terminal is omitted: opening it spawns a PTY (node-pty), which isn't built in
// this sandbox. The pop-out path is identical to the panes covered here — the
// only difference is the pane the detached window renders.
const PANES = [
  {
    mode: 'explorer',
    openLabel: 'Toggle right panel',
    listHost: '#file-tree-host',
    probe: '#file-tree-host .file-tree',
  },
  {
    mode: 'changes',
    openLabel: 'Open changes',
    listHost: '#git-changes-host',
    probe: '#git-changes-host .git-changes-list',
  },
  {
    mode: 'prs',
    openLabel: 'Open pull requests',
    listHost: '#pr-list-host',
    probe: '.pr-list-body',
  },
  {
    mode: 'browser',
    openLabel: 'Open browser',
    listHost: '#browser-tabs-host',
    probe: '#browser-tabs-host .browser-tabs-list',
  },
] as const

describe('Pane pop-out (mock gh)', () => {
  let mainHandle: string

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
    mainHandle = (await browser.getWindowHandles())[0]
  })

  after(async () => {
    // End on the main window so teardown / toast assertions run there. Any stray
    // pop-out is torn down with the session, so don't block on closeWindow here.
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone — nothing to do
    }
    resetUserData()
  })

  it('detaches each right-panel pane into its own window', async function () {
    this.timeout(180_000)

    for (const pane of PANES) {
      await browser.switchToWindow(mainHandle)

      // Make this pane the active one in the docked right panel.
      await $(`.titlebar-panel-controls [aria-label="${pane.openLabel}"]`).click()
      await $(pane.listHost).waitForDisplayed({ timeout: 20_000 })

      // The pop-out control lives inside the pane header, not the titlebar.
      const popoutBtn = await $(`${pane.listHost} .pane-popout-btn`)
      await popoutBtn.waitForClickable({ timeout: 10_000 })

      const before = await browser.getWindowHandles()
      await popoutBtn.click()
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > before.length,
        { timeout: 15_000, timeoutMsg: `expected a pop-out window for ${pane.mode}` },
      )
      const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
      expect(popoutHandle).toBeDefined()

      // The detached window renders only this pane; app chrome is collapsed and
      // the (now redundant) in-panel pop-out control is hidden.
      await browser.switchToWindow(popoutHandle as string)
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            (mode) => document.documentElement.getAttribute('data-popout-mode') === mode,
            pane.mode,
          )) === true,
        { timeout: 20_000, timeoutMsg: `popout window did not boot in ${pane.mode} mode` },
      )
      await $(pane.probe).waitForDisplayed({ timeout: 30_000 })
      await expect(await $('#pane-files')).toBeDisplayed()
      await expect(await $('#titlebar')).not.toBeDisplayed()
      await expect(await $('#pane-projects')).not.toBeDisplayed()
      await expect(await $('#pane-chat')).not.toBeDisplayed()
      await expect(await $('.pane-popout-btn')).not.toBeDisplayed()

      if (pane.mode === 'prs') {
        await browser.waitUntil(async () => (await $$('.pr-list-row')).length >= 2, {
          timeout: 30_000,
          timeoutMsg: 'expected the popped-out PR list to load its own data',
        })
      }

      await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, `pane-popout-${pane.mode}.png`))

      // Close this pop-out before opening the next so handles stay unambiguous.
      // Best-effort: a webview-backed window can be slow to close under
      // chromedriver, and a lingering handle doesn't break the new-handle diff.
      try {
        await browser.closeWindow()
      } catch {
        // leave it for session teardown
      }
      await browser.switchToWindow(mainHandle)
    }

    // The main window keeps its full three-pane layout; the pop-out control
    // lives inside the (currently open) pane, and not in the titlebar.
    await expect(await $('#pane-projects')).toBeDisplayed()
    await expect(await $('.prompt-input')).toBeExisting()
    await expect(await $('.titlebar-popout-btn')).not.toBeExisting()
    await expect(await $('#browser-tabs-host .pane-popout-btn')).toBeDisplayed()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'pane-popout-main.png'))
  })
})
