import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('Settings snapshot recovery', () => {
  let workspace = ''
  before(async () => {
    resetUserData()
    workspace = mkdtempSync(join(tmpdir(), 'copse-settings-retry-'))
    seedEmptyProject(workspace, 'e2e-settings-retry')
    writeE2eEnv({ COPSE_E2E_SETTINGS_SNAPSHOT_FAILURE: '1' })
    await browser.reloadSession()
  })
  after(() => {
    writeE2eEnv({ COPSE_E2E_SETTINGS_SNAPSHOT_FAILURE: undefined })
    resetUserData()
    rmSync(workspace, { recursive: true, force: true })
  })
  it('retries the failed load in the same dialog before enabling Save', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-load-retry').waitForDisplayed()
    await expect($('#settings-save-status')).toHaveText(
      expect.stringContaining('Temporary settings connection failure'),
    )
    await expect($('#settings-dialog button[type="submit"]')).toBeDisabled()
    await saveElementScreenshot('#settings-dialog', 'settings-load-failed.png')
    await $('#settings-load-retry').click()
    await $('#settings-dialog button[type="submit"]').waitForEnabled({ timeout: 15_000 })
    assert.equal(
      await browser.execute(() => document.querySelector('#settings-dialog')?.hasAttribute('open')),
      true,
    )
    await expect($('#settings-save-status')).not.toBeDisplayed()
    await expect($('#settings-load-retry')).not.toBeDisplayed()
    assert.equal(
      await browser.execute(
        () =>
          document.querySelector<HTMLElement>('.settings-section[data-section="general"]')?.inert,
      ),
      false,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-load-recovered.png')
  })
})
