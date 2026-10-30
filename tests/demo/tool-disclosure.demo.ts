import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// An explicit open/close on a tool card is the reader's choice: tool-status
// churn (running → done → running) must not override it. The disclosure model
// (src/renderer/views/disclosure-model.ts) owns that state, not the DOM.

describe('tool card disclosure choices', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/tool-disclosure-fixture.ts'],
      outfile: 'dist/demo/tool-disclosure-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/tool-disclosure-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><main id="fixture" style="width:700px;height:520px;display:flex;flex-direction:column"><div id="conversation" style="flex:1;min-height:0;overflow:auto"></div></main><script src="/tool-disclosure-fixture.js"></script></body></html>',
    )
  })

  it('keeps a user-closed running card closed and a user-opened card open through status churn', async () => {
    await browser.url('/tool-disclosure-fixture.html')
    const rollup = $('.tool-card-rollup')
    const shell = rollup.$('.tool-card[data-tool-id="tc-shell"]')
    const edit = rollup.$('.tool-card[data-tool-id="tc-edit"]')
    await rollup.waitForDisplayed()
    // Background activity starts compact; the reader opens it.
    await expect(rollup).not.toHaveAttribute('open')
    await rollup.$('summary').click()
    await expect(rollup).toHaveAttribute('open')

    // The reader looks at the running command, then closes it again, and
    // opens the finished edit.
    await shell.$('summary').click()
    await expect(shell).toHaveAttribute('open')
    await shell.$('summary').click()
    await edit.$('summary').click()
    await expect(shell).not.toHaveAttribute('open')
    await expect(edit).toHaveAttribute('open')

    const churn: ('running' | 'done')[] = ['done', 'running', 'done', 'running']
    for (const status of churn) {
      await browser.execute((next) => {
        window.toolDisclosureFixture.setShellStatus(next)
      }, status)
      await expect(shell).toHaveAttribute('data-status', status)
      await expect(rollup).toHaveAttribute('open')
      await expect(shell).not.toHaveAttribute('open')
      await expect(edit).toHaveAttribute('open')
    }
    // Outlast the reveal delay: the running card must not reopen itself.
    await browser.pause(500)
    await expect(rollup).toHaveAttribute('open')
    await expect(shell).toHaveAttribute('data-status', 'running')
    await expect(shell).not.toHaveAttribute('open')
    await expect(edit).toHaveAttribute('open')
    await expect(edit.$('.tool-result, .tool-args')).toBeDisplayed()

    await browser.execute(async () => {
      await document.fonts.ready
      for (const animation of document.getAnimations()) {
        animation.pause()
        animation.currentTime = 1250
      }
    })
    await saveElementScreenshot('#fixture', 'tool-disclosure-user-choices.png')
  })
})
