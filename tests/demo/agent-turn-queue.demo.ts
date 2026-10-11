import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('primary turn queue notice', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/agent-turn-queue-fixture.ts'],
      outfile: 'dist/demo/agent-turn-queue-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/agent-turn-queue-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><main id="fixture" style="width:700px;height:600px;display:flex;flex-direction:column"><div id="conversation" style="flex:1;min-height:0;overflow:auto"></div><div id="input"></div></main><script src="/agent-turn-queue-fixture.js"></script></body></html>',
    )
  })

  it('explains waiting while keeping the running turn Stop control visible', async () => {
    await browser.url('/agent-turn-queue-fixture.html')
    await expect($('#conversation')).toHaveText(
      expect.stringContaining('Waiting for an available agent slot.'),
    )
    await expect($('#conversation')).toHaveText(
      expect.stringContaining('You can stop this turn while it is queued.'),
    )
    await expect($('.stop-btn')).toBeDisplayed()
    await saveElementScreenshot('#fixture', 'agent-turn-queue.png', { frame: 'document' })
  })
})
