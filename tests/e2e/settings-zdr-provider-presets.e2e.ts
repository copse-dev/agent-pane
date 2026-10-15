import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  assertBadgeRecipe,
  assertNeutralBadge,
  readBadgeStyles,
  signalColours,
} from './helpers/badge-style.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSettings,
} from './helpers/seed-config.ts'

describe('ZDR provider presets', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-zdr-provider-presets')
    // A saved Groq key puts Groq in Models & agents; its Options show the preset.
    writeSettings({
      ...readSeededSettings(),
      apiKey: {
        groq: { v: 1, enc: Buffer.from('gsk_e2e', 'utf8').toString('base64'), plain: true },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('promotes privacy-forward endpoints and shows accurate Groq privacy details', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const list = $('[data-testid="models-agents-fieldset"]')
    await expect(list).toBeDisplayed()
    await list.$('[data-row="key:groq"]').waitForExist({ timeout: 15_000 })

    // Pasting a key offers every built-in provider by name.
    await list.$('[data-testid="connections-add-toggle"]').click()
    await list.$('.acp-add-row[data-add="key"]').$('button=Add key').click()
    await list.$('[data-testid="paste-key-input"]').setValue('Zq81mXk93LpTt20abCdEf')
    await expect(list.$('[data-testid="paste-key-ask"]')).toBeDisplayed()
    const providerLabels = await list
      .$$('[data-testid="paste-key-provider"] option')
      .map((option) => option.getText())
    for (const label of ['Groq', 'Together AI', 'Fireworks AI']) {
      assert.ok(providerLabels.includes(label), `expected ${label} as a key provider`)
    }

    // "Other" opens the custom endpoint form, whose known endpoints no longer
    // duplicate the promoted presets.
    await list.$('[data-testid="paste-key-provider"]').selectByAttribute('value', '__other')
    const knownEndpointLabels = await list
      .$$('[data-testid="paste-key-other"] select option')
      .map((option) => option.getText())
    for (const promoted of ['Groq', 'Together AI', 'Fireworks AI']) {
      assert.ok(
        !knownEndpointLabels.includes(promoted),
        `${promoted} should not remain duplicated under Other`,
      )
    }

    const providers = list.$('[data-row="key:groq"]')
    await providers.$('button=Options').click()
    const form = providers.$('.provider-form')
    await expect(form).toBeDisplayed()

    const details = await browser.execute(() => {
      const host = document.querySelector('[data-row="key:groq"]')
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
    assert.equal(details.badge, 'No training — retained ≤30 days')
    assert.equal(details.badgeKind, false)
    assert.match(details.policyHint, /temporarily log inference data/i)
    assert.equal(details.baseUrl, 'https://api.groq.com/openai/v1')

    // The built-in tag and the data-policy badge beside it share one badge
    // recipe (sentence case, --radius corner, one size); the tag is a neutral label.
    const [tag] = await readBadgeStyles('[data-row="key:groq"] .provider-form-tag')
    const [policyBadge] = await readBadgeStyles('[data-row="key:groq"] .provider-privacy-badge')
    assert.ok(tag, 'built-in tag rendered')
    assert.ok(policyBadge, 'data-policy badge rendered')
    assertBadgeRecipe(tag)
    assertBadgeRecipe(policyBadge)
    assertNeutralBadge(tag, await signalColours())

    await form.scrollIntoView({ block: 'center' })
    for (const selector of [
      '.provider-form-title',
      '.provider-privacy-badge',
      '.provider-privacy-hint',
      'input[type="url"]',
    ]) {
      assert.equal(
        await form.$(selector).isDisplayed({ withinViewport: true }),
        true,
        `${selector} must be visible`,
      )
    }
    await saveElementScreenshot('#settings-dialog', 'settings-zdr-provider-presets.png')
  })
})
