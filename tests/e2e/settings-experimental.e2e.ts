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

  it('hides the retired experimental toggles migrated to Settings > Packs', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    // The Experimental nav button switches to its section.
    const navBtn = $('.settings-nav-btn[data-section="experimental"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const experimental = settingsSection('experimental')
    await expect(experimental).toBeDisplayed()

    // MCP UI artefacts (canvas) migrated to the `copse.mcp-ui-canvas` first-party
    // pack (Settings > Packs), so the retired fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="mcpUiArtefactsEnabled"]').isExisting(),
      false,
      'mcpUiArtefactsEnabled must leave Settings > Experimental after pack migration',
    )
    assert.equal(await experimental.$('legend=MCP UI artefacts (canvas)').isExisting(), false)

    // DevTools shortcut migrated to the `copse.devtools-shortcut` first-party
    // pack (Settings > Packs), so the retired fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="devtoolsShortcutEnabled"]').isExisting(),
      false,
      'devtoolsShortcutEnabled must leave Settings > Experimental after pack migration',
    )
    assert.equal(await experimental.$('legend=DevTools shortcut').isExisting(), false)

    // CI investigator migrated from an experimental toggle to the
    // `copse.ci-investigator` first-party pack (Settings > Packs), so the retired
    // fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="ciInvestigatorEnabled"]').isExisting(),
      false,
      'ciInvestigatorEnabled must leave Settings > Experimental after pack migration',
    )
    assert.equal(await experimental.$('legend=CI investigator subagent').isExisting(), false)

    // Advisor strategy enablement migrated to the `copse.advisor-strategy` pack;
    // the retired checkbox must not appear. The orthogonal advisor model select
    // stays in a slimmed "Advisor model" fieldset.
    assert.equal(
      await experimental.$('input[name="advisorStrategyEnabled"]').isExisting(),
      false,
      'advisorStrategyEnabled must leave Settings > Experimental after pack migration',
    )
    await expect(experimental.$('legend=Advisor model')).toBeDisplayed()
    assert.equal(await experimental.$('legend=Advisor strategy').isExisting(), false)

    // OKF memories migrated from an experimental toggle to the
    // `copse.okf-memories` first-party pack (Settings > Packs), so the retired
    // fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="okfMemoriesEnabled"]').isExisting(),
      false,
      'okfMemoriesEnabled must leave Settings > Experimental — the pack owns it',
    )
    assert.equal(
      await experimental.$('legend=Memories (Open Knowledge Format)').isExisting(),
      false,
    )

    // CI investigator migrated from an experimental toggle to the
    // `copse.ci-investigator` first-party pack (Settings > Packs), so the
    // retired fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="ciInvestigatorEnabled"]').isExisting(),
      false,
      'ciInvestigatorEnabled must leave Settings > Experimental after pack migration',
    )
    assert.equal(await experimental.$('legend=CI investigator subagent').isExisting(), false)

    // Long-horizon tasks migrated from an experimental toggle to the
    // `copse.long-horizon-tasks` first-party pack (Settings > Packs), so the
    // retired fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="longHorizonTasksEnabled"]').isExisting(),
      false,
      'longHorizonTasksEnabled must leave Settings > Experimental after pack migration',
    )
    assert.equal(await experimental.$('legend=Long-horizon tasks').isExisting(), false)
    // PII redaction migrated from an experimental toggle to the
    // `copse.pii-redaction` first-party pack (Settings > Packs), so the retired
    // fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="piiRedactionEnabled"]').isExisting(),
      false,
      'piiRedactionEnabled must leave Settings > Experimental after pack migration',
    )
    assert.equal(await experimental.$('legend=PII redaction (on-device)').isExisting(), false)

    // Roadmap plans migrated from an experimental toggle to the
    // `copse.roadmap-plans` first-party pack (Settings > Packs), so the retired
    // fieldset must not appear here.
    assert.equal(
      await experimental.$('input[name="roadmapPlansEnabled"]').isExisting(),
      false,
      'roadmapPlansEnabled must leave Settings > Experimental — the pack owns it',
    )
    assert.equal(await experimental.$('legend=Roadmap plans').isExisting(), false)

    // Device agents graduated out of Experimental and are now set up per
    // provider under Settings > General, so no agents block belongs here.
    assert.equal(
      await experimental.$('legend=Agents on this device').isExisting(),
      false,
      'device agents must leave Settings > Experimental',
    )

    // The classifier is described in plain terms: how hard the task is and which
    // model suits it, with no internal tool or scale vocabulary.
    const classifierHint = await experimental
      .$('legend=Model classifier')
      .parentElement()
      .$('.field-hint')
    assert.match(await classifierHint.getText(), /how hard a task is/i)

    await saveElementScreenshot('#settings-dialog', 'settings-experimental.png')
  })
})
