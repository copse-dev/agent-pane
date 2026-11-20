import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * The section is about 660px tall with its images open, taller than the
 * fixture page's scroller in the browser's default viewport. An element
 * capture keeps only the slice on screen, so which slice it got depended on
 * the host's window chrome, and one run clipped the heading and readiness
 * line (#3693). Give the page room for the whole section.
 */
const VIEWPORT = { width: 1280, height: 900 }

async function setViewport(width: number, height: number): Promise<void> {
  const frame = await browser.execute(() => ({
    width: window.outerWidth - window.innerWidth,
    height: window.outerHeight - window.innerHeight,
  }))
  await browser.setWindowSize(width + frame.width, height + frame.height)
}

/**
 * Bring the section into view and fail if any of it lies outside the viewport
 * or a clipping ancestor: a capture would then miss that part.
 */
async function showWholeSection(): Promise<void> {
  await $('#storage-containers').scrollIntoView()
  const clipped = await browser.execute(() => {
    const section = document.getElementById('storage-containers')
    if (!section) return 'the section is missing'
    const box = section.getBoundingClientRect()
    const bounds = [{ name: 'the viewport', top: 0, bottom: window.innerHeight }]
    for (let node = section.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowY === 'visible') continue
      const rect = node.getBoundingClientRect()
      bounds.push({ name: `${node.tagName} ${node.className}`, top: rect.top, bottom: rect.bottom })
    }
    const outside = bounds.find((bound) => box.top < bound.top - 1 || box.bottom > bound.bottom + 1)
    return outside
      ? `section spans ${String(box.top)}–${String(box.bottom)}px, beyond ${outside.name} (${String(outside.top)}–${String(outside.bottom)}px)`
      : null
  })
  if (clipped !== null) throw new Error(`#storage-containers would be clipped: ${clipped}`)
}

describe('Apple container storage accounting', () => {
  before(async () => {
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    await build({
      entryPoints: ['tests/demo/helpers/container-storage-fixture.ts'],
      outfile: 'dist/demo/container-storage-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/container-storage-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"><style>#app.storage-fixture{display:flex;flex-direction:column;overflow:hidden;padding:24px;width:850px;height:100vh;background:var(--bg-base)}#app.storage-fixture .settings-content{min-height:0;width:100%;padding:0}#storage-saved-data{display:none}#storage-containers{max-width:800px}</style></head><body><div id="app"></div><script src="/container-storage-fixture.js"></script></body></html>',
    )
  })
  it('shows all allocated storage and cache metrics with explicit shared cleanup confirmation', async () => {
    await browser.url('/container-storage-fixture.html')
    await $('#storage-containers').scrollIntoView()
    await expect($('#storage-container-breakdown')).toHaveText(
      expect.stringContaining('22; 15 not matched to listed images'),
    )
    await expect($('#storage-worker-images-clean')).toBeEnabled()
    await expect($('#storage-apple-builder-clean')).toBeEnabled()
    await $('#storage-containers details summary').scrollIntoView()
    await $('#storage-containers details summary').click()
    await expect($('#storage-container-images')).toHaveText(
      expect.stringContaining('copse-worker:local'),
    )
    await expect($('#storage-containers-status')).toHaveText(
      expect.stringContaining('storage is ready'),
    )
    await showWholeSection()
    await saveElementScreenshot('#storage-containers', 'settings-container-storage.png')
    await $('#storage-apple-images-clean').scrollIntoView()
    await $('#storage-apple-images-clean').click()
    await expect($('#confirm-dialog')).toHaveText(expect.stringContaining('other applications'))
    await saveElementScreenshot('#confirm-dialog', 'settings-container-storage-confirm.png')
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await expect($('#storage-maintenance-status')).toHaveText(
      expect.stringContaining('cleanup finished'),
    )
  })
  it('disables every container cleanup action while containers or builds are in use', async () => {
    await browser.url('/container-storage-fixture.html?busy')
    await $('#storage-containers').scrollIntoView()
    await expect($('#storage-containers-status')).toHaveText(
      expect.stringContaining('Cleanup is paused'),
    )
    for (const action of ['worker-images', 'apple-images', 'apple-builder'])
      await expect($(`#storage-${action}-clean`)).toBeDisabled()
    await showWholeSection()
    await saveElementScreenshot('#storage-containers', 'settings-container-storage-busy.png')
  })
  it('hides Apple container storage when the container CLI is not installed', async () => {
    await browser.url('/container-storage-fixture.html?missing')
    // The saved-data rows fill in once the maintenance state has loaded.
    await browser.waitUntil(
      async () => (await $('#storage-runs-size').getProperty('textContent')) !== 'Checking…',
    )
    await expect($('#storage-containers')).not.toBeDisplayed()
  })
})
