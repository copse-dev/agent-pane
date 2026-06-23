import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedBrowserLinkChatFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

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

describe('chat browser links', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedBrowserLinkChatFixture(process.cwd())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('opens chat links in the browser panel and navigates to the URL', async () => {
    const message = await $('[data-message-id="msg-assistant-link"] .message-text')
    await message.waitForDisplayed({ timeout: 15_000 })

    const link = await message.$('a')
    await link.waitForDisplayed({ timeout: 5_000 })
    await expect(link).toHaveAttribute('href', expect.stringContaining('example.com'))

    await link.click()
    await browser.pause(300)

    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const host = document.getElementById('browser-viewer-host')
          return host != null && !host.hidden
        }),
      {
        timeout: 5_000,
        timeoutMsg: 'expected browser viewer to show',
      },
    )

    const urlInput = await $('.browser-tab-panel.is-active .browser-url-input')
    await urlInput.waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(async () => (await urlInput.getValue()).includes('example.com'), {
      timeout: 5_000,
      timeoutMsg: 'expected address bar to show example.com',
    })

    await waitForWebviewTitle('Example Domain')
    await browser.pause(300)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'browser-link-chat-example-com.png'))
  })
})
