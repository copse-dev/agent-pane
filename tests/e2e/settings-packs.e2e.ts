import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Settings → Packs list — P3 of docs/plans/hooks-and-feature-packs.md.
//
// The pack list is the "about:addons" surface of Copse: one row per registered
// pack, with an enable/disable toggle, an enumeration of what the pack
// contributes, and any pack-scoped settings the manifest declares. This spec
// asserts:
//  - the Packs nav button + section render;
//  - the shipped first-party todos pack shows up in
//    the list with a first-party trust badge and an enable toggle;
//  - toggling persists (round-trips through the electron-store) and the row
//    marks itself disabled;
//  - a full-section screenshot lands in tests/e2e/screenshots for visual review.
//
// The removed P1 `copse.noop` skeleton must not leak into the user-facing list.

function settingsSection(section: string) {
  return $(`.settings-section[data-section="${section}"]`)
}

describe('settings packs (about:addons)', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-packs')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lists installed packs with an enable toggle + contribution enumeration', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()

    const navBtn = dialog.$('button[data-section="packs"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const packs = settingsSection('packs')
    await expect(packs).toBeDisplayed()
    await expect(packs.$('legend=Installed packs')).toBeDisplayed()

    // Section copy must stay user-facing: no internal design-doc refs, and the
    // add-a-pack guide must be a real link (not a bare <code> path).
    const desc = packs.$('.settings-section-desc')
    await expect(desc).toBeDisplayed()
    const descText = await desc.getText()
    assert.doesNotMatch(descText, /decision\s*17/i)
    const docsLink = desc.$(
      'a[href="https://github.com/copse-dev/agent-pane/blob/main/docs/adding-a-pack.md"]',
    )
    await expect(docsLink).toBeDisplayed()
    assert.match(await docsLink.getText(), /how to add a pack/i)

    // Wait for the async `packs:list` IPC to resolve and render a real
    // first-party pack. The old skeleton was a development fixture and should
    // no longer appear as an installed user-facing pack.
    const todosRow = packs.$('.pack-row[data-pack-id="copse.todos"]')
    await todosRow.waitForExist({ timeout: 15_000 })
    await expect(todosRow.$('.pack-name')).toBeDisplayed()
    assert.equal(await todosRow.$('.pack-name').getText(), 'copse.todos')
    assert.equal(await packs.$('.pack-row[data-pack-id="copse.noop"]').isExisting(), false)

    // Long-horizon tasks pack (#558): listed, default-OFF (ships disabled).
    const longHorizonRow = packs.$('.pack-row[data-pack-id="copse.long-horizon-tasks"]')
    await expect(longHorizonRow).toBeDisplayed()
    assert.equal(await longHorizonRow.$('.pack-name').getText(), 'copse.long-horizon-tasks')
    await expect(longHorizonRow.$('.pack-badge-first-party')).toBeDisplayed()
    assert.equal(await longHorizonRow.getAttribute('data-enabled'), 'false')
    // Roadmap plans pack (#556): listed, default-OFF (ships disabled).
    const roadmapPlansRow = packs.$('.pack-row[data-pack-id="copse.roadmap-plans"]')
    await expect(roadmapPlansRow).toBeDisplayed()
    assert.equal(await roadmapPlansRow.$('.pack-name').getText(), 'copse.roadmap-plans')
    await expect(roadmapPlansRow.$('.pack-badge-first-party')).toBeDisplayed()
    assert.equal(await roadmapPlansRow.getAttribute('data-enabled'), 'false')

    // Advisor strategy pack: listed, default-OFF (ships disabled).
    const advisorRow = packs.$('.pack-row[data-pack-id="copse.advisor-strategy"]')
    await expect(advisorRow).toBeDisplayed()
    assert.equal(await advisorRow.$('.pack-name').getText(), 'copse.advisor-strategy')
    await expect(advisorRow.$('.pack-badge-first-party')).toBeDisplayed()
    assert.equal(await advisorRow.getAttribute('data-enabled'), 'false')

    // OKF memories pack: listed, default-OFF (ships disabled).
    const okfMemoriesRow = packs.$('.pack-row[data-pack-id="copse.okf-memories"]')
    await expect(okfMemoriesRow).toBeDisplayed()
    assert.equal(await okfMemoriesRow.$('.pack-name').getText(), 'copse.okf-memories')
    await expect(okfMemoriesRow.$('.pack-badge-first-party')).toBeDisplayed()
    assert.equal(await okfMemoriesRow.getAttribute('data-enabled'), 'false')

    // CI investigator pack: listed, default-OFF (ships disabled).
    const ciInvestigatorRow = packs.$('.pack-row[data-pack-id="copse.ci-investigator"]')
    await expect(ciInvestigatorRow).toBeDisplayed()
    assert.equal(await ciInvestigatorRow.$('.pack-name').getText(), 'copse.ci-investigator')
    await expect(ciInvestigatorRow.$('.pack-badge-first-party')).toBeDisplayed()
    assert.equal(await ciInvestigatorRow.getAttribute('data-enabled'), 'false')

    // PII redaction pack: listed, default-OFF (ships disabled).
    const packRow = packs.$('.pack-row[data-pack-id="copse.pii-redaction"]')
    await expect(packRow).toBeDisplayed()
    assert.equal(await packRow.$('.pack-name').getText(), 'copse.pii-redaction')
    await expect(packRow.$('.pack-badge-first-party')).toBeDisplayed()
    assert.equal(await packRow.getAttribute('data-enabled'), 'false')

    // Local cron automations are a new, explicit opt-in. Upgrading
    // must not arm a clock-driven feature until the user enables the pack.
    const automationsRow = packs.$('.pack-row[data-pack-id="copse.automations"]')
    await expect(automationsRow).toBeDisplayed()
    assert.equal(await automationsRow.getAttribute('data-enabled'), 'false')

    // Post-turn review pack: its pack-scoped `maxReviewCycles` setting renders
    // as a generic number field seeded with the manifest default. This is the
    // "does a failing review buy the agent another turn?" knob — 1 reports the
    // failing verdict and stops, 2 (default) allows one remediation turn plus a
    // re-review.
    const postTurnReviewRow = packs.$('.pack-row[data-pack-id="copse.post-turn-review"]')
    await expect(postTurnReviewRow).toBeDisplayed()
    const reviewCyclesInput = postTurnReviewRow.$(
      'input.pack-setting-number[data-setting-key="maxReviewCycles"]',
    )
    await expect(reviewCyclesInput).toBeDisplayed()
    assert.equal(await reviewCyclesInput.getValue(), '2')

    // Trust tier badge is shown.
    await expect(todosRow.$('.pack-badge-first-party')).toBeDisplayed()

    // The toggle is a checkbox and starts enabled.
    const toggle = todosRow.$('input.pack-toggle-input')
    await expect(toggle).toBeExisting()
    assert.equal(await toggle.isSelected(), true)
    assert.equal(await todosRow.getAttribute('data-enabled'), 'true')

    // The checkbox is visually hidden behind the slider track — click the
    // wrapper label (the interactive element) to fire the change event, the
    // same pattern the MCP list uses.
    const toggleLabel = todosRow.$('label.pack-toggle')
    await toggleLabel.click()

    // Disabling flips the row's data-enabled and adds the greyed-out class
    // (the P1 atomic-flag contract, surfaced to the user).
    await browser.waitUntil(async () => (await todosRow.getAttribute('data-enabled')) === 'false', {
      timeout: 5_000,
      timeoutMsg: 'expected pack row to reflect disabled state',
    })
    assert.equal(await toggle.isSelected(), false)
    const cls = (await todosRow.getAttribute('class')) ?? ''
    assert.ok(cls.includes('pack-row-disabled'), 'disabled row must be visually greyed')

    await saveElementScreenshot('#settings-dialog', 'settings-packs.png')
  })
})
