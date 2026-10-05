import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

// Settings → Storage → Merged threads: the control behind the auto-archive
// sweep (#3330). The sweep itself is unit-tested against fakes; this proves the
// control reads the saved value, writes a new one, and leaves a value past the
// schema bound unsaved instead of losing the whole save to a rejected write.

const FIELD = 'input[name="autoArchiveAfterDays"]'

async function openStorage(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').$('button[data-section="storage"]').click()
  await $(FIELD).waitForDisplayed({ timeout: 30_000 })
}

async function saveSettings(): Promise<void> {
  await $('#settings-dialog').$('button[type="submit"]').click()
  await browser.waitUntil(async () => !(await $('#settings-dialog').isDisplayed()), {
    timeout: 15_000,
    timeoutMsg: 'expected the settings dialog to close after saving',
  })
}

describe('Auto-archive setting', function () {
  this.timeout(90_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-auto-archive-settings')
    seedE2eViewport({ width: 1280, height: 800 }, { autoArchiveAfterDays: 7 })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the saved delay under Storage', async () => {
    await openStorage()
    const fieldset = $('.storage-auto-archive-fieldset')
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('legend')).toHaveText('Merged threads')
    assert.equal(await $(FIELD).getValue(), '7')
    await saveElementScreenshot('#settings-dialog', 'settings-auto-archive.png')
  })

  it('saves a new delay', async () => {
    await $(FIELD).setValue('3')
    await saveSettings()
    await openStorage()
    assert.equal(await $(FIELD).getValue(), '3')
  })

  it('refuses a delay past the schema bound, and can be turned off', async () => {
    await $(FIELD).setValue('9999')
    // The input's max blocks the submit, so the dialog stays open on the bad value.
    await $('#settings-dialog').$('button[type="submit"]').click()
    assert.equal(
      await browser.execute(
        () =>
          document.querySelector<HTMLInputElement>('input[name="autoArchiveAfterDays"]')?.validity
            .rangeOverflow,
      ),
      true,
    )
    await expect($('#settings-dialog')).toBeDisplayed()

    await $(FIELD).setValue('0')
    await saveSettings()
    await openStorage()
    assert.equal(await $(FIELD).getValue(), '0')
  })
})
