import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted subagent ungrouped beside reading tools (#728)', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=subagent-ungrouped')
    await $('.tool-card-subagent').waitForExist()
  })

  it('keeps Explored files as its own card next to Read file', async () => {
    await expect($$('.tool-card-subagent')).toBeElementsArrayOfSize(1)
    await expect($$('.tool-card-group')).toBeElementsArrayOfSize(0)
    await expect($$('[data-tool-id="demo-ungrouped-read"]')).toBeElementsArrayOfSize(1)
    const exploreName = await $('.tool-card-subagent .tool-name').getText()
    expect(exploreName).toBe('Explored files')
    await saveAppScreenshot('subagent-ungrouped-beside-read.png')
  })
})
