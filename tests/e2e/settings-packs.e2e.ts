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
//  - the shipped first-party pack (`copse.noop`, the P1 skeleton) shows up in
//    the list with a first-party trust badge and an enable toggle;
//  - toggling persists (round-trips through the electron-store) and the row
//    marks itself disabled;
//  - a full-section screenshot lands in tests/e2e/screenshots for visual review.
//
// The visible pack set widens with P4 (todos pack contributes tools/hooks/UI);
// this spec is written to hold across that change — it asserts the noop pack
// is present, not that it is the only pack.

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

    const description = packs.$('.settings-section-desc')
    await expect(description).toBeDisplayed()
    assert.doesNotMatch(await description.getText(), /decision 17|docs\/packs\.md/)
    const manifestDocs = description.$('a=the pack manifest docs')
    await expect(manifestDocs).toBeDisplayed()
    assert.equal(
      await manifestDocs.getAttribute('href'),
      'https://github.com/copse-dev/agent-pane/blob/main/docs/packs.md',
    )
    assert.equal(await manifestDocs.getAttribute('target'), '_blank')
    assert.match((await manifestDocs.getAttribute('rel')) ?? '', /noopener/)

    // The P1 skeleton pack ships as first-party; wait for the async
    // `packs:list` IPC to resolve and render a row for it.
    const noopRow = packs.$('.pack-row[data-pack-id="copse.noop"]')
    await noopRow.waitForExist({ timeout: 15_000 })
    await expect(noopRow.$('.pack-name')).toBeDisplayed()
    const nameText = await noopRow.$('.pack-name').getText()
    assert.equal(nameText, 'copse.noop')

    // Trust tier badge is shown.
    await expect(noopRow.$('.pack-badge-first-party')).toBeDisplayed()

    // The toggle is a checkbox and starts enabled — the P1 default.
    const toggle = noopRow.$('input.pack-toggle-input')
    await expect(toggle).toBeExisting()
    assert.equal(await toggle.isSelected(), true)
    assert.equal(await noopRow.getAttribute('data-enabled'), 'true')

    // The checkbox is visually hidden behind the slider track — click the
    // wrapper label (the interactive element) to fire the change event, the
    // same pattern the MCP list uses.
    const toggleLabel = noopRow.$('label.pack-toggle')
    await toggleLabel.click()

    // Disabling flips the row's data-enabled and adds the greyed-out class
    // (the P1 atomic-flag contract, surfaced to the user).
    await browser.waitUntil(async () => (await noopRow.getAttribute('data-enabled')) === 'false', {
      timeout: 5_000,
      timeoutMsg: 'expected pack row to reflect disabled state',
    })
    assert.equal(await toggle.isSelected(), false)
    const cls = (await noopRow.getAttribute('class')) ?? ''
    assert.ok(cls.includes('pack-row-disabled'), 'disabled row must be visually greyed')

    await saveElementScreenshot('#settings-dialog', 'settings-packs.png')
  })
})
