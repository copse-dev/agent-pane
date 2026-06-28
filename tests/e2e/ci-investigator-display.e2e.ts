import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedCiInvestigatorFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('CI investigator subagent display', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedCiInvestigatorFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the Investigate CI subagent card with nested CI log tools', async () => {
    await $('.tool-card-subagent').waitForExist({ timeout: 15_000 })

    const card = await $('.tool-card-subagent')
    await expect(card).toBeDisplayed()
    await expect(card).not.toHaveAttribute('open')
    await expect(card.$('summary.tool-card-header .tool-name')).toHaveText('Investigate CI')

    await saveAppScreenshot('ci-investigator-display-collapsed.png')

    await card.$('summary.tool-card-header').click()
    await expect(card.$('.subagent-message-assistant strong')).toHaveText('failing run logs')
    const innerText = await card.$$('.subagent-inner-tool .tool-name').map((n) => n.getText())
    await expect(innerText).toContain('List CI runs')
    await expect(innerText).toContain('View CI run logs')

    await saveAppScreenshot('ci-investigator-display-expanded.png')
  })
})
