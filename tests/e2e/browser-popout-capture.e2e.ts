import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { navigateActiveBrowserTab } from './helpers/browser-address.ts'
import { listenOnFixturePort } from './helpers/fixture-server.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

// The Browser pane's capture IPC must accept a tab hosted by the pane pop-out
// window, not only one hosted by the boot main window.

interface CaptureApi {
  api: { browser: { captureScreenshot(webContentsId: number): Promise<{ dataUrl: string }> } }
}

interface GuestWebview {
  getTitle(): string
  getWebContentsId(): number
}

const FIXTURE_TITLE = 'Pop-out capture fixture'

describe('Browser pane capture from the pop-out window', function () {
  this.timeout(120_000)
  let server: Server | null = null
  let mainHandle = ''

  before(async () => {
    resetUserData()
    seedE2eViewport()
    seedE2eThreePaneLayout()
    seedEmptyProject(seedStableWorkspace(), 'e2e-browser-popout-capture')
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>${FIXTURE_TITLE}</title><h1>Pop-out capture</h1>`)
    })
    const origin = await listenOnFixturePort(server, 43131)

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    mainHandle = (await browser.getWindowHandles())[0] ?? ''
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await navigateActiveBrowserTab(`${origin}/capture`)
    await browser.waitUntil(
      async () =>
        (await $('.browser-tabs-tab.is-active .browser-tabs-tab-label').getText()) ===
        FIXTURE_TITLE,
      { timeout: 15_000, timeoutMsg: 'fixture page did not load in the docked Browser pane' },
    )
  })

  after(async () => {
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone
    }
    resetUserData()
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve())
      else resolve()
    })
  })

  it('captures a screenshot of a tab the pop-out hosts', async () => {
    const before = await browser.getWindowHandles()
    const popoutBtn = await $('#browser-tabs-host .pane-popout-btn')
    await popoutBtn.waitForClickable({ timeout: 10_000 })
    await popoutBtn.click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'pop-out window did not open',
    })
    const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    if (!popoutHandle) throw new Error('pop-out handle unavailable')
    await browser.switchToWindow(popoutHandle)
    await browser.waitUntil(
      async () =>
        await browser.execute((title) => {
          const view = document.querySelector('.browser-tab-panel.is-active webview')
          return (view as unknown as GuestWebview | null)?.getTitle() === title
        }, FIXTURE_TITLE),
      { timeout: 20_000, timeoutMsg: 'fixture page did not load in the pop-out Browser pane' },
    )

    const outcome = await browser.execute(async () => {
      const view = document.querySelector('.browser-tab-panel.is-active webview')
      const id = (view as unknown as GuestWebview).getWebContentsId()
      try {
        const shot = await (window as unknown as CaptureApi).api.browser.captureScreenshot(id)
        return shot.dataUrl.startsWith('data:image/') ? 'ok' : 'no image'
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })
    expect(outcome).toBe('ok')
  })
})
