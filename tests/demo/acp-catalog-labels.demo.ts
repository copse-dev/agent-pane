import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('ACP catalog labels before configured settings load', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/acp-catalog-labels-fixture.ts'],
      outfile: 'dist/demo/acp-catalog-labels-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/acp-catalog-labels-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/acp-catalog-labels-fixture.js"></script></body></html>',
    )
  })

  it('renders friendly catalog titles through actual compact model-picker fallback', async () => {
    await browser.url('/acp-catalog-labels-fixture.html')
    await $('.model-picker-trigger').waitForDisplayed()
    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.model-picker-label')].map((node) => node.textContent?.trim()),
    )
    assert.deepEqual(labels, ['Codex', 'Codex — GPT-5.6 Sol', 'Gemini CLI', 'unknown-agent'])
    const fits = await browser.execute(() =>
      [...document.querySelectorAll('.model-picker-trigger')].every(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    )
    assert.ok(fits, 'all fallback labels fit their compact trigger')
    await saveElementScreenshot('#app', 'acp-catalog-model-labels.png')
  })
})
