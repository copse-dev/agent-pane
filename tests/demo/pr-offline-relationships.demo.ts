import { $, $$, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Local PR relationships without GitHub details', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/pr-offline-relationships-fixture.ts'],
      outfile: 'dist/demo/pr-offline-relationships-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/pr-offline-relationships-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/pr-offline-relationships-fixture.js"></script></body></html>',
    )
  })
  for (const mode of ['unavailable', 'unauthenticated']) {
    it(`refreshes production while GitHub is ${mode}`, async () => {
      await browser.url(`/pr-offline-relationships-fixture.html?mode=${mode}`)
      await $('.pr-list-row').waitForClickable()
      await $('.pr-list-row').click()
      await expect($('.pr-thread-group[data-relationship-group="produced"]')).not.toExist()
      await $('#record-production').click()
      await expect($('.pr-thread-link[data-thread-id="producer"]')).toHaveText(
        'Implement widget\nCreated PR',
      )
      await expect($$('.pr-thread-link[data-relationship="related"]')).toBeElementsArrayOfSize(1)
      await expect($('.pr-viewer-title')).toHaveText('#42 acme/widgets')
      await expect($('.panel-empty')).toHaveText(
        mode === 'unavailable'
          ? 'Install GitHub CLI to load pull request details.'
          : 'Sign in with GitHub CLI to load pull request details.',
      )
      await saveElementScreenshot('#pane-files', `pr-relationships-${mode}-refreshed.png`)
    })
  }
})
