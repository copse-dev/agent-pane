import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Auto to ACP context estimate lifecycle', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/auto-acp-context-fixture.ts'],
      outfile: 'dist/demo/auto-acp-context-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/auto-acp-context-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><div id="fixture-controls" style="position:fixed;left:660px;top:24px"></div><script src="/auto-acp-context-fixture.js"></script></body></html>',
    )
  })

  it('drops the native estimate and waits for the first ACP usage before showing a ring', async () => {
    await browser.url('/auto-acp-context-fixture.html')
    const wheel = $('.context-wheel')
    await wheel.waitForDisplayed()
    await wheel.moveTo()
    await expect($('.context-wheel-popover-header')).toHaveText('Context · 30.0k / 200.0k (15%)')
    await saveElementScreenshot('#app', 'auto-acp-context-native.png', { frame: 'document' })

    await $('#resolve-acp').click()
    await expect(wheel).not.toBeDisplayed()
    await expect($('.context-wheel-popover')).not.toBeDisplayed()
    assert.equal(await $('#fixture-controls').getAttribute('data-estimates'), '1')
    await saveElementScreenshot('#app', 'auto-acp-context-awaiting-usage.png', {
      frame: 'document',
    })

    await $('#report-usage').click()
    await wheel.waitForDisplayed()
    await wheel.moveTo()
    await expect($('.context-wheel-popover-header')).toHaveText('Context · 80.0k / 200.0k (40%)')
    await expect($('.context-wheel-popover-note')).toHaveText('Reported by ACP agent')
    await expect($('.context-wheel-popover-row')).not.toExist()
    assert.equal(await $('#fixture-controls').getAttribute('data-estimates'), '1')
    await saveElementScreenshot('#app', 'auto-acp-context-reported.png', { frame: 'document' })
  })

  it('ignores a native estimate returned after Auto has resolved to ACP', async () => {
    await browser.url('/auto-acp-context-fixture.html?mode=late')
    await browser.waitUntil(
      async () => (await $('#fixture-controls').getAttribute('data-estimates')) === '1',
    )
    await $('#resolve-acp').click()
    await $('#finish-estimate').click()
    await browser.pause(350)
    await expect($('.context-wheel')).not.toBeDisplayed()
    await saveElementScreenshot('#app', 'auto-acp-context-late-estimate.png', { frame: 'document' })
  })
})
