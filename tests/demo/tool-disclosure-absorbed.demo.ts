import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// A running tool that is absorbed into a rollup inside its reveal delay is
// background activity: the delayed reveal it scheduled on its own must not pop
// it open inside the rollup (disclosure-model.ts cancels it, #3962).

describe('tool card absorbed into a rollup', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/tool-disclosure-absorbed-fixture.ts'],
      outfile: 'dist/demo/tool-disclosure-absorbed-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/tool-disclosure-absorbed-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><main id="fixture" style="width:700px;height:520px;display:flex;flex-direction:column"><div id="conversation" style="flex:1;min-height:0;overflow:auto"></div></main><script src="/tool-disclosure-absorbed-fixture.js"></script></body></html>',
    )
  })

  it('keeps the absorbed running card closed after the reveal delay', async () => {
    await browser.url('/tool-disclosure-absorbed-fixture.html')
    const rollup = $('.tool-card-rollup')
    const shell = rollup.$('.tool-card[data-tool-id="tc-shell"]')
    const edit = rollup.$('.tool-card[data-tool-id="tc-edit"]')
    await rollup.waitForDisplayed()
    await expect(shell).toHaveAttribute('data-status', 'running')
    // Outlast the reveal delay the card scheduled before it was absorbed.
    await browser.pause(500)
    await expect(rollup).not.toHaveAttribute('open')

    // The reader opens the rollup: every row inside is still compact.
    await rollup.$('summary').click()
    await expect(rollup).toHaveAttribute('open')
    await expect(shell).toHaveAttribute('data-status', 'running')
    await expect(shell).not.toHaveAttribute('open')
    await expect(edit).not.toHaveAttribute('open')

    await browser.execute(async () => {
      await document.fonts.ready
      for (const animation of document.getAnimations()) {
        animation.pause()
        animation.currentTime = 1250
      }
    })
    await saveElementScreenshot('#fixture', 'tool-disclosure-absorbed-closed.png')
  })
})
