import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('ZDR provider presets', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-zdr-provider-presets')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('promotes every default-ZDR endpoint and shows Groq privacy details', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const providers = $('#settings-custom-providers-host fieldset')
    await expect(providers).toBeDisplayed()
    await providers.$('button=Groq').waitForExist({ timeout: 15_000 })

    const chipLabels = await providers.$$('.provider-chip').map((chip) => chip.getText())
    for (const label of ['Groq', 'Together AI', 'Fireworks AI']) {
      assert.ok(chipLabels.includes(label), `expected a ${label} provider chip`)
    }

    await providers.$('button=Other').click()
    const knownEndpointLabels = await providers
      .$$(`select option`)
      .map((option) => option.getText())
    for (const promoted of ['Groq', 'Together AI', 'Fireworks AI']) {
      assert.ok(
        !knownEndpointLabels.includes(promoted),
        `${promoted} should not remain duplicated under Other`,
      )
    }

    await providers.$('button=Groq').click()
    const form = providers.$('.provider-form')
    await expect(form).toBeDisplayed()

    const details = await browser.execute(() => {
      const host = document.querySelector('#settings-custom-providers-host')
      const title = host?.querySelector('.provider-form-title')
      const badge = title?.querySelector('.provider-privacy-badge')
      const policyHint = host?.querySelector('.provider-privacy-hint')
      const baseUrl = host?.querySelector<HTMLInputElement>('input[type="url"]')
      return {
        title: title?.textContent?.trim() ?? '',
        badge: badge?.textContent?.trim() ?? '',
        badgeKind: badge?.classList.contains('zdr') ?? false,
        policyHint: policyHint?.textContent?.trim() ?? '',
        baseUrl: baseUrl?.value ?? '',
      }
    })

    assert.match(details.title, /^Groq/)
    assert.equal(details.badge, 'Zero data retention')
    assert.equal(details.badgeKind, true)
    assert.match(details.policyHint, /does not retain inference data by default/i)
    assert.equal(details.baseUrl, 'https://api.groq.com/openai/v1')

    await saveElementScreenshot('#settings-dialog', 'settings-zdr-provider-presets.png')
  })
})
