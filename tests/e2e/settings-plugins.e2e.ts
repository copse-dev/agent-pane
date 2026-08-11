import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Settings → Plugins list — P3 of docs/plans/hooks-and-feature-packs.md.
//
// The plugin list is the "about:addons" surface of Copse: one row per registered
// plugin, with an enable/disable toggle, an enumeration of what the plugin
// contributes, and any plugin-scoped settings the manifest declares. This spec
// asserts:
//  - the Plugins nav button + section render;
//  - the shipped first-party todos plugin shows up in
//    the list with first-party + stability badges and an enable toggle;
//  - toggling persists (round-trips through the electron-store) and the row
//    marks itself disabled;
//  - a full-section screenshot lands in tests/e2e/screenshots for visual review.
//
// The removed P1 `copse.noop` skeleton must not leak into the user-facing list.

function settingsSection(section: string) {
  return $(`.settings-section[data-section="${section}"]`)
}

describe('settings plugins (about:addons)', function () {
  this.timeout(60_000)
  let localPluginRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    localPluginRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-selected-plugin-'))
    mkdirSync(join(localPluginRoot, 'dist'))
    writeFileSync(join(localPluginRoot, 'dist', 'index.mjs'), 'export default {}\n')
    writeFileSync(
      join(localPluginRoot, 'copse-plugin.json'),
      JSON.stringify({
        name: 'personal.reference-tools',
        version: '0.1.0',
        description: 'A selected reference tool plugin.',
        tools: {
          provides: ['personal_reference_judge'],
        },
        models: {
          provides: [
            {
              id: 'reference-judge',
              label: 'Reference judge',
              group: 'Personal models',
              description: 'A private second-opinion route.',
              supportsImages: true,
            },
          ],
        },
        browser: { origins: ['https://example.test'] },
        runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
      }),
    )
    seedEmptyProject(process.cwd(), 'e2e-settings-plugins', {
      pluginSources: [localPluginRoot],
      model: 'plugin-model:personal.reference-tools:reference-judge',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (localPluginRoot) rmSync(localPluginRoot, { recursive: true, force: true })
  })

  it('lists installed plugins with an enable toggle + contribution enumeration', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()

    const navBtn = dialog.$('button[data-section="customise"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const plugins = settingsSection('customise')
    await expect(plugins).toBeDisplayed()
    await expect(plugins.$('legend=Plugins')).toBeDisplayed()

    // Plugin copy must stay user-facing: no internal design-doc refs, and the
    // add-a-plugin guide must be a real link (not a bare <code> path). It lives
    // on the Plugins fieldset now that plugins are one part of Customise.
    const desc = plugins.$('#plugins-fieldset .settings-fieldset-desc')
    await expect(desc).toBeDisplayed()
    const descText = await desc.getText()
    assert.doesNotMatch(descText, /decision\s*17/i)
    const docsLink = desc.$(
      'a[href="https://github.com/copse-dev/agent-pane/blob/main/docs/adding-a-plugin.md"]',
    )
    await expect(docsLink).toBeDisplayed()
    assert.match(await docsLink.getText(), /how to add a plugin/i)

    // Wait for the async `plugins:list` IPC to resolve and render a real
    // first-party plugin. The old skeleton was a development fixture and should
    // no longer appear as an installed user-facing plugin.
    // `.plugin-name` shows the sentence-cased display name, not the machine id:
    // settings-dialog.ts strips the `copse.` prefix for first-party plugins and
    // keeps known acronyms uppercase. `data-plugin-id` remains the identity pin.
    const todosRow = plugins.$('.plugin-row[data-plugin-id="copse.todos"]')
    await todosRow.waitForExist({ timeout: 15_000 })
    await expect(todosRow.$('.plugin-name')).toBeDisplayed()
    assert.equal(await todosRow.$('.plugin-name').getText(), 'Todos')
    assert.equal(await plugins.$('.plugin-row[data-plugin-id="copse.noop"]').isExisting(), false)

    // Long-horizon tasks plugin (#558): listed, default-OFF (ships disabled).
    const longHorizonRow = plugins.$('.plugin-row[data-plugin-id="copse.long-horizon-tasks"]')
    await expect(longHorizonRow).toBeDisplayed()
    assert.equal(await longHorizonRow.$('.plugin-name').getText(), 'Long horizon tasks')
    await expect(longHorizonRow.$('.plugin-badge-first-party')).toBeDisplayed()
    await expect(longHorizonRow.$('.plugin-badge-experimental')).toHaveText('Experimental')
    assert.equal(await longHorizonRow.getAttribute('data-enabled'), 'false')
    // Roadmap plans plugin (#556): listed, default-OFF (ships disabled).
    const roadmapPlansRow = plugins.$('.plugin-row[data-plugin-id="copse.roadmap-plans"]')
    await expect(roadmapPlansRow).toBeDisplayed()
    assert.equal(await roadmapPlansRow.$('.plugin-name').getText(), 'Roadmap plans')
    await expect(roadmapPlansRow.$('.plugin-badge-first-party')).toBeDisplayed()
    assert.equal(await roadmapPlansRow.getAttribute('data-enabled'), 'false')

    // Advisor strategy plugin: listed, default-OFF (ships disabled).
    const advisorRow = plugins.$('.plugin-row[data-plugin-id="copse.advisor-strategy"]')
    await expect(advisorRow).toBeDisplayed()
    assert.equal(await advisorRow.$('.plugin-name').getText(), 'Advisor strategy')
    await expect(advisorRow.$('.plugin-badge-first-party')).toBeDisplayed()
    assert.equal(await advisorRow.getAttribute('data-enabled'), 'false')

    // OKF memories plugin: listed, default-OFF (ships disabled).
    const okfMemoriesRow = plugins.$('.plugin-row[data-plugin-id="copse.okf-memories"]')
    await expect(okfMemoriesRow).toBeDisplayed()
    assert.equal(await okfMemoriesRow.$('.plugin-name').getText(), 'OKF memories')
    await expect(okfMemoriesRow.$('.plugin-badge-first-party')).toBeDisplayed()
    assert.equal(await okfMemoriesRow.getAttribute('data-enabled'), 'false')

    // CI investigator plugin: listed, default-OFF (ships disabled).
    const ciInvestigatorRow = plugins.$('.plugin-row[data-plugin-id="copse.ci-investigator"]')
    await expect(ciInvestigatorRow).toBeDisplayed()
    assert.equal(await ciInvestigatorRow.$('.plugin-name').getText(), 'CI investigator')
    await expect(ciInvestigatorRow.$('.plugin-badge-first-party')).toBeDisplayed()
    assert.equal(await ciInvestigatorRow.getAttribute('data-enabled'), 'false')

    // PII redaction plugin: listed, default-OFF (ships disabled).
    const pluginRow = plugins.$('.plugin-row[data-plugin-id="copse.pii-redaction"]')
    await expect(pluginRow).toBeDisplayed()
    assert.equal(await pluginRow.$('.plugin-name').getText(), 'PII redaction')
    await expect(pluginRow.$('.plugin-badge-first-party')).toBeDisplayed()
    assert.equal(await pluginRow.getAttribute('data-enabled'), 'false')

    // Background execution is a stable primitive and is available without a
    // fresh-profile opt-in. Loopback binding still prompts separately at use time.
    const backgroundTasksRow = plugins.$('.plugin-row[data-plugin-id="copse.background-tasks"]')
    await expect(backgroundTasksRow).toBeDisplayed()
    await expect(backgroundTasksRow.$('.plugin-badge-stable')).toHaveText('Stable')
    assert.equal(await backgroundTasksRow.getAttribute('data-enabled'), 'true')
    await backgroundTasksRow.scrollIntoView()
    await saveElementScreenshot(
      '.plugin-row[data-plugin-id="copse.background-tasks"]',
      'settings-background-tasks-plugin.png',
    )

    // Website creative-engineering steering is a stable, default-on product
    // behavior. Its plugin row makes the guidance and disable boundary visible.
    const siteBuildingRow = plugins.$('.plugin-row[data-plugin-id="copse.site-building"]')
    await expect(siteBuildingRow).toBeDisplayed()
    assert.equal(await siteBuildingRow.$('.plugin-name').getText(), 'Site building')
    await expect(siteBuildingRow.$('.plugin-badge-stable')).toHaveText('Stable')
    assert.equal(await siteBuildingRow.getAttribute('data-enabled'), 'true')
    assert.match(await siteBuildingRow.getText(), /design, implementation, accessibility/i)
    await siteBuildingRow.scrollIntoView()
    await saveElementScreenshot(
      '.plugin-row[data-plugin-id="copse.site-building"]',
      'settings-site-building-plugin.png',
    )

    // Local cron automations are a new, explicit opt-in. Upgrading
    // must not arm a clock-driven feature until the user enables the plugin.
    const automationsRow = plugins.$('.plugin-row[data-plugin-id="copse.automations"]')
    await expect(automationsRow).toBeDisplayed()
    assert.equal(await automationsRow.getAttribute('data-enabled'), 'false')

    // A selected directory remains an ordinary user plugin. Its declared tool
    // behavior is visible even when this platform cannot start the macOS-only
    // isolated worker and therefore leaves the plugin disabled.
    const pluginToolRow = plugins.$('.plugin-row[data-plugin-id="personal.reference-tools"]')
    await expect(pluginToolRow).toBeDisplayed()
    await expect(pluginToolRow.$('.plugin-badge-user')).toBeDisplayed()
    assert.equal(await pluginToolRow.getAttribute('data-enabled'), 'false')
    assert.equal(await pluginToolRow.$('input.plugin-toggle-input').isEnabled(), true)
    const localText = await pluginToolRow.getText()
    assert.match(localText, /executable behaviors run in isolation/i)
    assert.match(localText, /Tools × 1/)
    assert.match(localText, /Models × 1/)
    assert.match(localText, /Browser origins × 1/)
    assert.match(localText, /sha256:[a-f0-9]{64}/)

    await pluginToolRow.scrollIntoView()
    await saveElementScreenshot(
      '.plugin-row[data-plugin-id="personal.reference-tools"]',
      'settings-selected-plugin.png',
    )

    // Post-turn review plugin: its plugin-scoped `maxReviewCycles` setting renders
    // as a generic number field seeded with the manifest default. This is the
    // "does a failing review buy the agent another turn?" knob — 1 reports the
    // failing verdict and stops, 2 (default) allows one remediation turn plus a
    // re-review.
    const postTurnReviewRow = plugins.$('.plugin-row[data-plugin-id="copse.post-turn-review"]')
    await expect(postTurnReviewRow).toBeDisplayed()
    // A plugin's fields live behind its closed "Plugin settings" disclosure.
    await postTurnReviewRow.$('.plugin-settings-summary').click()
    const reviewCyclesInput = postTurnReviewRow.$(
      'input.plugin-setting-number[data-setting-key="maxReviewCycles"]',
    )
    await expect(reviewCyclesInput).toBeDisplayed()
    assert.equal(await reviewCyclesInput.getValue(), '2')

    // Trust tier badge is shown. Stability reads as a sentence-case pill.
    await expect(todosRow.$('.plugin-badge-first-party')).toBeDisplayed()
    await expect(todosRow.$('.plugin-badge-stable')).toHaveText('Stable')

    // The toggle is a checkbox and starts enabled.
    const toggle = todosRow.$('input.plugin-toggle-input')
    await expect(toggle).toBeExisting()
    assert.equal(await toggle.isSelected(), true)
    assert.equal(await todosRow.getAttribute('data-enabled'), 'true')

    // The checkbox is visually hidden behind the slider track — click the
    // wrapper label (the interactive element) to fire the change event, the
    // same pattern the MCP list uses.
    const toggleLabel = todosRow.$('label.plugin-toggle')
    await toggleLabel.click()

    // Disabling flips the row's data-enabled and adds the greyed-out class
    // (the P1 atomic-flag contract, surfaced to the user).
    await browser.waitUntil(async () => (await todosRow.getAttribute('data-enabled')) === 'false', {
      timeout: 5_000,
      timeoutMsg: 'expected plugin row to reflect disabled state',
    })
    assert.equal(await toggle.isSelected(), false)
    const cls = (await todosRow.getAttribute('class')) ?? ''
    assert.ok(cls.includes('plugin-row-disabled'), 'disabled row must be visually greyed')

    await saveElementScreenshot('#settings-dialog', 'settings-plugins.png')

    // The same manifest metadata is represented in the thread model picker.
    // This fixture deliberately registers no handlers, so the selected route
    // remains visible with its friendly label but cannot be run.
    await browser.keys('Escape')
    await dialog.waitForDisplayed({ reverse: true })
    const footerPicker = $('.footer-model-host')
    await footerPicker.$('.model-picker-trigger').click()
    const personalModel = footerPicker.$(
      '.model-picker-option[data-value="plugin-model:personal.reference-tools:reference-judge"]',
    )
    await personalModel.waitForExist({ timeout: 15_000 })
    assert.equal(await personalModel.getText(), 'Reference judge (plugin disabled)')
    assert.equal(await personalModel.isEnabled(), false)
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'personal-plugin-thread-model-picker.png',
    )
  })
})
