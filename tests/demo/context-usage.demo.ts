import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('context label and subagent usage states', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/context-usage-fixture.ts'],
      outfile: 'dist/demo/context-usage-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/context-usage-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/context-usage-fixture.js"></script></body></html>',
    )
  })

  for (const [mode, summary, runCount] of [
    ['running', '1 run · 1 running', 1],
    ['done', '1 run · no usage reported', 1],
    ['mixed', '2 runs · 100 in / 10 out · 1 without usage', 2],
  ] as const) {
    it(`shows ${mode} usage without contradicting the context hover`, async () => {
      await browser.url(`/context-usage-fixture.html?mode=${mode}`)
      const wheel = await $('.context-wheel').getElement()
      await wheel.waitForDisplayed()
      assert.equal(await wheel.getAttribute('title'), 'Context: 6.8k / 200.0k (3%)')
      assert.equal(await wheel.getAttribute('aria-label'), 'Context 3% used, 6.8k of 200.0k tokens')
      await wheel.moveTo()
      const popover = await $('.context-wheel-popover').getElement()
      await expect(popover).toBeDisplayed()
      await expect(popover.$('.context-wheel-popover-header')).toHaveText(
        'Context · 6.8k / 200.0k (3%)',
      )
      assert.ok((await popover.getText()).includes(summary))
      await expect(popover.$$('.footer-usage-popover-row.is-run')).toBeElementsArrayOfSize(runCount)
      const bounds = await browser.execute(() => {
        const element = document.querySelector('.context-wheel-popover')
        if (!element) throw new Error('Missing context hover')
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      })
      assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= 640 && bounds.bottom <= 480)
      await saveElementScreenshot('#app', `context-usage-${mode}.png`)
    })
  }
})
