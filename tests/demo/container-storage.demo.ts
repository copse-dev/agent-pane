import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Apple container storage accounting', () => {
  before(async () => {
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
    await $('#storage-containers').scrollIntoView()
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
    await $('#storage-containers').scrollIntoView()
    await saveElementScreenshot('#storage-containers', 'settings-container-storage-busy.png')
  })
})
