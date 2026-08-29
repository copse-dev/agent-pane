import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted subagent display reference', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=subagent-display')
    await $('.tool-card-subagent').waitForExist()
    await browser.waitUntil(async () => (await $$('.tool-card-subagent')).length === 2)
  })

  it('captures the collapsed and expanded subagent card', async () => {
    const card = await $('.tool-card-subagent')
    await saveAppScreenshot('subagent-display-collapsed.png')
    await card.$('summary.tool-card-header').click()
    await saveAppScreenshot('subagent-display-expanded.png')
  })

  it('shows a named custom agent and the concrete model it ran', async () => {
    const cards = await $$('.tool-card-subagent')
    let customCard = null
    for (const card of cards) {
      if ((await card.getText()).includes('security-reviewer')) customCard = card
    }
    assert.ok(customCard, 'expected the security-reviewer custom-agent card')
    await expect(customCard.$('.tool-name')).toHaveText('Ran security-reviewer')
    await customCard.$('summary.tool-card-header').click()
    await expect(customCard.$('.subagent-model')).toHaveText('Claude Opus 4.8')
    await saveAppScreenshot('custom-subagent-display-expanded.png')
  })
})
