import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-browser-display-project'
const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

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
    const input = document.querySelector(
      '.browser-tab-panel.is-active .browser-url-input',
    ) as HTMLInputElement | null
    if (!input) return
    input.value = targetUrl
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const goBtn = document.querySelector(
      '.browser-tab-panel.is-active .browser-go-btn',
    ) as HTMLButtonElement | null
    goBtn?.click()
  }, url)
}

async function waitForWebviewTitle(expected: string, timeoutMs = 25_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = await browser.execute(() => {
        const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
          getTitle?: () => string
        } | null
        return webview?.getTitle?.() ?? ''
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
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
    await waitForComposer()
  })

  after(() => {
    resetUserData()
  })

  it('opens browser mode with tabs, toolbar, and loaded page', async () => {
    await openBrowserMode()

    await expect($('.browser-tabs-list-header')).toHaveText(expect.stringMatching(/tabs/i))
    await expect($('.browser-tabs-tab.is-active .browser-tabs-tab-label')).toHaveText('New tab')
    await expect($('.browser-toolbar')).toBeDisplayed()
    await expect($('.browser-nav-btn[aria-label="Back"]')).toBeDisplayed()
    await expect($('.browser-go-btn')).toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-mode-empty.png'))

    await navigateActiveTab('https://example.com')
    await waitForWebviewTitle('Example Domain')
    await browser.pause(500)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-mode-example-com.png'))

    const newTabBtn = await $('.browser-tabs-new-btn')
    await newTabBtn.click()
    await browser.waitUntil(async () => (await $$('.browser-tabs-tab')).length >= 2, {
      timeout: 5_000,
      timeoutMsg: 'expected second browser tab after clicking +',
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-mode-two-tabs.png'))
  })
})
