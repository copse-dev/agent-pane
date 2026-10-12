import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

// The Add flow's API-key branch is one paste-a-key box: Copse works out the
// provider from the key's prefix and only asks when it cannot. Saving needs the
// provider's network check, so this spec stops at detection.
describe('Paste an API key in Settings', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-paste-key', {
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('names the provider for a recognised key and asks about an unknown one', async function () {
    this.timeout(60_000)
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="general"]').click()
    await $('#settings-providers-host .provider-chip[data-provider="other"]').click()

    const form = $('#settings-providers-host [data-testid="paste-key-form"]')
    await form.waitForDisplayed({ timeout: 15_000 })
    const input = form.$('[data-testid="paste-key-input"]')
    const hint = form.$('[data-testid="paste-key-hint"]')
    const ask = form.$('[data-testid="paste-key-ask"]')
    await expect(form.$('[data-testid="paste-key-save"]')).toBeDisabled()

    await input.setValue('sk-ant-api03-abcdef123456')
    await expect(hint).toHaveText('Looks like an Anthropic key.', { containing: true })
    await expect(ask).not.toBeDisplayed()
    await expect(form.$('[data-testid="paste-key-save"]')).toBeEnabled()

    // The key box and the status line stay on one row group and inside the form.
    const overflow = await browser.execute(() => {
      const host = document.querySelector('#settings-providers-host [data-testid="paste-key-form"]')
      return host ? host.scrollWidth - host.clientWidth : -1
    })
    assert.ok(overflow <= 0, 'paste-key form must not overflow sideways')

    await input.setValue('Zq81mXk93LpTt20abCdEf')
    await expect(hint).toHaveText('doesn’t recognise this key', { containing: true })
    await expect(ask).toBeDisplayed()

    await $('#settings-providers-host fieldset').scrollIntoView({ block: 'center' })
    await browser.pause(200)
    await saveElementScreenshot('#settings-providers-host fieldset', 'settings-paste-key.png')
  })
})
