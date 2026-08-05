import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-browser-thread-sharing'

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function navigateActiveTab(url: string): Promise<void> {
  await browser.execute((targetUrl) => {
    const input = document.querySelector<HTMLInputElement>(
      '.browser-tab-panel.is-active .browser-url-input',
    )
    const go = document.querySelector<HTMLButtonElement>(
      '.browser-tab-panel.is-active .browser-go-btn',
    )
    if (!input || !go) throw new Error('active browser toolbar is unavailable')
    input.value = targetUrl
    go.click()
  }, url)
}

async function openBrowserMenu(): Promise<void> {
  await $('.browser-menu-btn').click()
  await expect($('.browser-menu')).toBeDisplayed()
}

async function clickBrowserMenuItem(label: string): Promise<void> {
  const items = await $$('.browser-menu-item')
  for (const item of items) {
    if ((await item.getText()) === label) {
      await item.click()
      return
    }
  }
  throw new Error(`browser menu item not found: ${label}`)
}

describe('browser context sharing with a thread', function () {
  this.timeout(90_000)
  let server: Server | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(process.cwd(), PROJECT_ID)

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Browser sharing fixture</title>
            <style>
              body { font: 16px system-ui; margin: 40px; color: #1c2822; background: #f3f5ef; }
              article { max-width: 620px; padding: 28px; background: white; border: 1px solid #c7d0c8; }
              h1 { margin-top: 0; }
            </style>
          </head>
          <body>
            <article>
              <h1>Browser research notes</h1>
              <p>This visible paragraph is shared as text with the active Copse thread.</p>
              <p>Select this sentence and use the page context menu to share only the selection.</p>
            </article>
          </body>
        </html>`)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server has no TCP port')

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await $('.browser-url-input').waitForDisplayed({ timeout: 10_000 })
    await navigateActiveTab(`http://127.0.0.1:${String(address.port)}/notes`)
    await browser.waitUntil(
      async () =>
        (await $('.browser-tabs-tab.is-active .browser-tabs-tab-label').getText()) ===
        'Browser sharing fixture',
      { timeout: 15_000, timeoutMsg: 'expected local sharing fixture to finish loading' },
    )
  })

  after(async () => {
    resetUserData()
    await closeServer(server)
  })

  it('uses a legible URL selection and dismisses overflow on guest focus', async () => {
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.browser-url-input')
      if (!input) throw new Error('browser address input missing')
      input.focus()
      input.select()
    })

    const selectionStyle = await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.browser-url-input')
      if (!input) throw new Error('browser address input missing')
      const style = getComputedStyle(input, '::selection')
      return { backgroundColor: style.backgroundColor, color: style.color }
    })
    assert.equal(selectionStyle.backgroundColor, 'rgb(32, 253, 133)')
    assert.equal(selectionStyle.color, 'rgb(68, 68, 68)')

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.browser-menu-btn')?.click()
    })
    await expect($('.browser-menu')).toBeDisplayed()
    await expect($('.browser-menu-item:nth-of-type(1)')).toHaveText('Share page text')
    await expect($('.browser-menu-item:nth-of-type(2)')).toHaveText('Share screenshot')
    await saveElementScreenshot('#pane-files', 'browser-address-selection-sharing-menu.png')

    await $('.browser-webview').click()
    await expect($('.browser-menu')).not.toBeDisplayed()
  })

  it('attaches page text and a viewport screenshot to the active composer', async () => {
    await openBrowserMenu()
    await clickBrowserMenuItem('Share page text')

    const textChip = $('.prompt-input .inline-paste-chip')
    await textChip.waitForDisplayed({ timeout: 10_000 })
    expect(await textChip.getText()).toContain('Browser page — Browser sharing fixture')
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const chip = document.querySelector<HTMLElement>('.inline-paste-chip')
          return chip?.title === 'Browser page — Browser sharing fixture'
        }),
      { timeout: 5_000, timeoutMsg: 'expected sourced browser text chip' },
    )

    await openBrowserMenu()
    await clickBrowserMenuItem('Share screenshot')
    const image = $('.attachment-chips .image-chip img')
    await image.waitForDisplayed({ timeout: 10_000 })
    assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/)

    await browser.pause(2_100)
    await saveAppScreenshot('browser-thread-sharing-attachments.png')
  })
})
