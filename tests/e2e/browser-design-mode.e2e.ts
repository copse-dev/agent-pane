import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import type { WebviewTag } from 'electron'
import { $, $$, browser, expect } from '@wdio/globals'
import { navigateActiveBrowserTab } from './helpers/browser-address.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { listenOnFixturePort } from './helpers/fixture-server.ts'
import { E2E_SCREENSHOT_DIR, saveAppViewportScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-browser-design-mode'

const FIXTURE = `<!doctype html>
<html>
  <head>
    <title>Design mode fixture</title>
    <style>
      body { font: 16px system-ui; margin: 32px; color: #1c2822; background: #f3f5ef; }
      .hero { max-width: 560px; padding: 24px; background: white; border: 1px solid #c7d0c8; border-radius: 10px; }
      h1 { margin: 0 0 12px; font-size: 26px; }
      .cta { padding: 10px 18px; border: 0; border-radius: 6px; background: #20603a; color: white; font-size: 15px; }
    </style>
  </head>
  <body>
    <section class="hero" data-inspector-relative-path="src/Hero.tsx" data-inspector-line="14" data-inspector-column="5">
      <h1 id="headline">Ship your first preview</h1>
      <p>Start a free trial and invite your team.</p>
      <button class="cta" type="button" onclick="document.title = 'clicked'">Start trial</button>
    </section>
  </body>
</html>`

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Centre of a guest element, in CSS px from the webview's top-left. */
async function guestCentre(selector: string): Promise<{ x: number; y: number }> {
  return await browser.execute(async (sel) => {
    const guest = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
    if (!guest) throw new Error('guest webview missing')
    const rect: unknown = await guest.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    )
    if (
      typeof rect !== 'object' ||
      rect === null ||
      !('x' in rect) ||
      !('y' in rect) ||
      typeof rect.x !== 'number' ||
      typeof rect.y !== 'number'
    ) {
      throw new Error('guest rect missing')
    }
    return { x: rect.x, y: rect.y }
  }, selector)
}

/** Move over and click a guest element with real pointer input. */
async function clickInGuest(selector: string): Promise<void> {
  const point = await guestCentre(selector)
  const host = await $('.browser-tab-panel.is-active .browser-webview')
  const size = await host.getSize()
  // WebDriver offsets are from the element's centre.
  const x = Math.round(point.x - size.width / 2)
  const y = Math.round(point.y - size.height / 2)
  await host.moveTo({ xOffset: x, yOffset: y })
  await browser.pause(150)
  await host.click({ x, y })
}

describe('browser design mode', function () {
  this.timeout(120_000)
  let server: Server | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID)

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE)
    })
    // The address bar is in frame, so the port must not change per run.
    const origin = await listenOnFixturePort(server, 43141)

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await $('.browser-url-input').waitForDisplayed({ timeout: 10_000 })
    await navigateActiveBrowserTab(`${origin}/pricing`)
    await browser.waitUntil(
      async () =>
        (await $('.browser-tabs-tab.is-active .browser-tabs-tab-label').getText()) ===
        'Design mode fixture',
      { timeout: 15_000, timeoutMsg: 'expected design mode fixture to finish loading' },
    )
  })

  after(async () => {
    resetUserData()
    await closeServer(server)
  })

  it('pins clicked elements with a note each, without the page acting on the click', async () => {
    const toggle = $('.browser-tab-panel.is-active .browser-design-btn')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const tray = $('.browser-tab-panel.is-active .browser-design-tray')
    await expect(tray).toBeDisplayed()
    await expect($('.browser-design-hint')).toHaveText(
      'Click an element to pin it. Esc stops picking.',
    )

    await clickInGuest('.cta')
    await $('.browser-design-item').waitForDisplayed({ timeout: 10_000 })
    await $('.browser-design-item:nth-of-type(1) .browser-design-note').setValue(
      'Use the brand pink and make it a pill',
    )

    await clickInGuest('#headline')
    await browser.waitUntil(async () => (await $$('.browser-design-item').length) === 2, {
      timeout: 10_000,
      timeoutMsg: 'expected a second pinned element',
    })
    await $('.browser-design-item:nth-of-type(2) .browser-design-note').setValue(
      'Tighter letter spacing',
    )

    const rows = await browser.execute(() =>
      Array.from(document.querySelectorAll('.browser-design-item')).map((row) => ({
        badge: row.querySelector('.browser-design-badge')?.textContent ?? '',
        selector: row.querySelector('.browser-design-selector')?.textContent ?? '',
        source: row.querySelector('.browser-design-source')?.textContent ?? '',
        thumb: row.querySelector('img.browser-design-thumb')?.getAttribute('src') ?? '',
      })),
    )
    assert.deepEqual(
      rows.map(({ badge, selector, source }) => ({ badge, selector, source })),
      [
        { badge: '1', selector: 'section.hero > button.cta', source: 'src/Hero.tsx:14:5' },
        { badge: '2', selector: 'h1#headline', source: 'src/Hero.tsx:14:5' },
      ],
    )
    for (const row of rows) assert.match(row.thumb, /^data:image\/png;base64,/)
    await expect($('.browser-design-send')).toHaveText('Send 2 to agent')

    // The picker swallowed the click: the button's own handler never ran.
    const title = await browser.execute(async () => {
      const guest = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      return guest ? String(await guest.executeJavaScript('document.title')) : ''
    })
    assert.equal(title, 'Design mode fixture')

    // Move off the elements so the hover outline does not sit in the frame.
    await $('.browser-design-title').moveTo()
    await saveAppViewportScreenshot('browser-design-mode-tray.png')
  })

  it('sends the pinned elements to the composer as one note plus their crops', async () => {
    await $('.browser-design-send').click()
    const chip = $('.prompt-input .inline-paste-chip')
    await chip.waitForDisplayed({ timeout: 10_000 })
    expect(await chip.getText()).toContain('Design notes: 2 elements')
    await browser.waitUntil(
      async () => (await $$('.attachment-chips .image-chip img').length) === 2,
      {
        timeout: 10_000,
        timeoutMsg: 'expected one image per pinned element',
      },
    )
    await expect($('.browser-tab-panel.is-active .browser-design-tray')).not.toBeDisplayed()
    await expect($('.browser-tab-panel.is-active .browser-design-btn')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
