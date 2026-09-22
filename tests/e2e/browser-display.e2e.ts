import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebviewTag } from 'electron'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedE2eViewport,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { startBrowserPageFixture } from './helpers/browser-page-fixture.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-browser-display-project'

async function waitForComposer(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
}

async function openBrowserMode(): Promise<void> {
  const browserBtn = await $('.titlebar-btn[aria-label="Open browser"]')
  await browserBtn.click()

  const pane = await $('#pane-files')
  await browser.waitUntil(async () => await pane.isDisplayed(), {
    timeout: 10_000,
    timeoutMsg: 'expected pane-files to open from titlebar',
  })

  await expect(browserBtn).toHaveElementClass('active')
  await $('.browser-url-input').waitForDisplayed({ timeout: 5_000 })
}

async function navigateActiveTab(url: string): Promise<void> {
  await browser.execute((targetUrl) => {
    const input = document.querySelector<HTMLInputElement>(
      '.browser-tab-panel.is-active .browser-url-input',
    )
    if (!input) throw new Error('active browser address input missing')
    input.value = targetUrl
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const goBtn = document.querySelector<HTMLButtonElement>(
      '.browser-tab-panel.is-active .browser-go-btn',
    )
    if (!goBtn) throw new Error('active browser go button missing')
    goBtn.click()
  }, url)
}

async function waitForWebviewTitle(expected: string, timeoutMs = 25_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = await browser.execute(() => {
        const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
        return webview && !webview.isLoading() ? webview.getTitle() : ''
      })
      return title.toLowerCase().includes(expected.toLowerCase())
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `expected webview title to contain ${expected}`,
    },
  )
}

describe('browser panel display', () => {
  let page: Awaited<ReturnType<typeof startBrowserPageFixture>>

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedE2eViewport()
    page = await startBrowserPageFixture(43120)
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, { webAllowedOrigins: [page.origin] })
    await browser.reloadSession()
    await waitForComposer()
  })

  after(async () => {
    resetUserData()
    await page?.close()
  })

  it('opens browser mode with tabs, toolbar, and loaded page', async () => {
    await openBrowserMode()

    await expect($('.browser-tabs-list-header')).toHaveText(expect.stringMatching(/tabs/i))
    await expect($('.browser-tabs-tab.is-active .browser-tabs-tab-label')).toHaveText('New tab')
    await expect($('.browser-toolbar')).toBeDisplayed()
    await expect($('.browser-nav-btn[aria-label="Back"]')).toBeDisplayed()
    await expect($('.browser-go-btn')).toBeDisplayed()

    // Tabs header + URL toolbar share `--browser-chrome-band-height` so their
    // bottom borders form one continuous line across the tree resizer.
    const chromeAlign = await browser.execute(() => {
      const header = document.querySelector('.browser-tabs-list-header')
      const toolbar = document.querySelector('.browser-toolbar')
      if (!header || !toolbar) throw new Error('missing browser chrome')
      const headerRect = header.getBoundingClientRect()
      const toolbarRect = toolbar.getBoundingClientRect()
      const headerStyle = getComputedStyle(header)
      const toolbarStyle = getComputedStyle(toolbar)
      return {
        headerTop: headerRect.top,
        headerBottom: headerRect.bottom,
        headerHeight: headerRect.height,
        toolbarTop: toolbarRect.top,
        toolbarBottom: toolbarRect.bottom,
        toolbarHeight: toolbarRect.height,
        headerCssHeight: headerStyle.height,
        toolbarCssHeight: toolbarStyle.height,
        viewerBorderTop: getComputedStyle(document.getElementById('browser-viewer-host')!)
          .borderTopWidth,
      }
    })
    expect(chromeAlign.headerCssHeight).toBe(chromeAlign.toolbarCssHeight)
    expect(Math.abs(chromeAlign.headerHeight - chromeAlign.toolbarHeight)).toBeLessThanOrEqual(1)
    expect(Math.abs(chromeAlign.headerTop - chromeAlign.toolbarTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(chromeAlign.headerBottom - chromeAlign.toolbarBottom)).toBeLessThanOrEqual(1)
    expect(chromeAlign.viewerBorderTop).toBe('0px')

    await saveElementScreenshot('#pane-files', 'browser-mode-empty.png')
    // Crop the Tabs | toolbar seam so band alignment is reviewable.
    await prepareE2eScreenshot()
    await browser.execute(() => {
      const header = document.querySelector('.browser-tabs-list-header')
      const toolbar = document.querySelector('.browser-toolbar')
      const pane = document.getElementById('pane-files')
      if (!header || !toolbar || !pane) throw new Error('missing browser chrome')
      const top =
        Math.min(header.getBoundingClientRect().top, toolbar.getBoundingClientRect().top) - 8
      const bottom =
        Math.max(header.getBoundingClientRect().bottom, toolbar.getBoundingClientRect().bottom) + 48
      const left = pane.getBoundingClientRect().left
      const right = pane.getBoundingClientRect().right
      const host = document.createElement('div')
      host.id = 'e2e-browser-chrome-seam'
      host.style.cssText = [
        'position:fixed',
        `left:${String(left)}px`,
        `width:${String(right - left)}px`,
        `top:${String(top)}px`,
        `height:${String(bottom - top)}px`,
        'z-index:9999',
        'pointer-events:none',
      ].join(';')
      document.body.append(host)
    })
    const seam = await $('#e2e-browser-chrome-seam')
    await seam.waitForExist({ timeout: 5_000 })
    await seam.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'browser-chrome-tabs-toolbar-seam.png'))
    await browser.execute(() => document.getElementById('e2e-browser-chrome-seam')?.remove())

    await navigateActiveTab(page.url)
    await waitForWebviewTitle('Copse browser fixture')
    await expect($('.browser-tab-panel.is-active .browser-url-input')).toHaveValue(page.url)
    expect(page.requests).toContain('/page')
    const heading = await browser.execute(async () => {
      const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      if (!webview) throw new Error('active browser webview missing')
      return webview.executeJavaScript("document.querySelector('h1')?.textContent")
    })
    expect(heading).toBe('Local browser page')
    // Capture the full app: WebDriver's element crop can misalign a native guest surface.
    await saveAppScreenshot('browser-mode-local-page.png')

    const newTabBtn = await $('.browser-tabs-new-btn')
    await newTabBtn.click()
    await browser.waitUntil(async () => (await $$('.browser-tabs-tab')).length >= 2, {
      timeout: 5_000,
      timeoutMsg: 'expected second browser tab after clicking +',
    })
    await saveElementScreenshot('#pane-files', 'browser-mode-two-tabs.png')
  })
})
