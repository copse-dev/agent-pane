import { $, browser } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted subagent display reference', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=subagent-display')
    await $('.tool-card-subagent').waitForExist()
  })

  it('captures the collapsed and expanded subagent card', async () => {
    const card = await $('.tool-card-subagent')
    await saveAppScreenshot('subagent-display-collapsed.png')
    await card.$('summary.tool-card-header').click()
    await saveAppScreenshot('subagent-display-expanded.png')
  })
})
