import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

function settingsSection(section: 'general' | 'experimental') {
  return $(`.settings-section[data-section="${section}"]`)
}

describe('experimental settings section', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-experimental')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('exposes the MCP UI artefacts toggle, off by default', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    // The Experimental nav button switches to its section.
    const navBtn = $('.settings-nav-btn[data-section="experimental"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const experimental = settingsSection('experimental')
    await expect(experimental).toBeDisplayed()
    await expect(experimental.$('legend=MCP UI artefacts (canvas)')).toBeDisplayed()

    const toggle = await experimental.$('input[name="mcpUiArtefactsEnabled"]')
    await expect(toggle).toBeExisting()
    // Off by default — opt-in only.
    assert.equal(await toggle.isSelected(), false)

    // The CI investigator subagent is also an opt-in experimental toggle.
    await expect(experimental.$('legend=CI investigator subagent')).toBeDisplayed()
    const ciToggle = await experimental.$('input[name="ciInvestigatorEnabled"]')
    await expect(ciToggle).toBeExisting()
    assert.equal(await ciToggle.isSelected(), false)

    // OKF memories are likewise an opt-in experimental toggle, off by default.
    await expect(experimental.$('legend=Memories (Open Knowledge Format)')).toBeDisplayed()
    const memoriesToggle = await experimental.$('input[name="okfMemoriesEnabled"]')
    await expect(memoriesToggle).toBeExisting()
    assert.equal(await memoriesToggle.isSelected(), false)

    // The model classifier speaks the shared intellect scale, not a separate
    // tier vocabulary (docs/plans/advisor-strategy.md).
    const classifierHint = await experimental
      .$('legend=Model classifier')
      .parentElement()
      .$('.field-hint')
    assert.match(await classifierHint.getText(), /shared model\s+intellect scale/i)

    await saveElementScreenshot('#settings-dialog', 'settings-experimental-mcp-ui.png')
  })
})
