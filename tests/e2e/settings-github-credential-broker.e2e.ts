import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const FIELDSET =
  '.settings-section[data-section="experimental"] fieldset:has(input[name="githubCredentialBrokerEnabled"])'

async function openExperimental(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').waitForDisplayed()
  await $('#settings-dialog button[data-section="experimental"]').click()
  await $(FIELDSET).scrollIntoView({ block: 'center' })
}

async function saveAndRestart(): Promise<void> {
  await $('#settings-dialog .settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await openExperimental()
}

describe('Brokered GitHub credentials setting', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-settings-github-credential-broker')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('defaults off, states its limits and persists opting in and out', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openExperimental()
    const toggle = (): ReturnType<typeof $> => $('input[name="githubCredentialBrokerEnabled"]')
    await expect(toggle()).not.toBeSelected()
    const hint = (await $(FIELDSET).$('.field-hint').getText()).replace(/\s+/g, ' ')
    assert.match(hint, /no longer receive GH_TOKEN or GITHUB_TOKEN/)
    assert.match(hint, /api\.github\.com only/)
    assert.match(hint, /Commands inside the sandbox can only read/)
    assert.match(
      hint,
      /Not covered: git over HTTPS, SSH workspaces, and Linux commands inside the sandbox/,
    )
    assert.match(hint, /can still read your gh login from disk/)
    await saveElementScreenshot(FIELDSET, 'settings-github-credential-broker-off.png')

    await toggle().click()
    await saveAndRestart()
    await expect(toggle()).toBeSelected()
    await saveElementScreenshot(FIELDSET, 'settings-github-credential-broker-on.png')

    await toggle().click()
    await saveAndRestart()
    await expect(toggle()).not.toBeSelected()
  })
})
