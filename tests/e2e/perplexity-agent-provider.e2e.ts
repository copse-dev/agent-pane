import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('Perplexity Agent API provider', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-perplexity-agent-provider')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the Responses API preset and its web-enabled model shortlist', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-section[data-section="general"]').waitForExist({ timeout: 15_000 })

    const selected = await browser.execute(() => {
      const chip = [...document.querySelectorAll<HTMLButtonElement>('.provider-chip')].find(
        (element) => element.textContent?.trim() === 'Perplexity Agent API',
      )
      chip?.click()
      return !!chip
    })
    assert.equal(selected, true, 'expected the Perplexity Agent API provider chip')

    await $('.provider-form input[type="url"]').waitForExist({ timeout: 5_000 })
    const form = await browser.execute(() => {
      const root = document.querySelector<HTMLElement>('.provider-form')
      const url = root?.querySelector<HTMLInputElement>('input[type="url"]')
      const modelIds = [
        ...(root?.querySelectorAll<HTMLInputElement>('.provider-model-row input') ?? []),
      ]
        .filter((_input, index) => index % 5 === 0)
        .map((input) => input.value)
      return {
        title: root?.querySelector('.provider-form-title')?.firstChild?.textContent?.trim() ?? '',
        baseUrl: url?.value ?? '',
        baseUrlReadOnly: url?.readOnly ?? false,
        keyHint:
          root?.querySelector('.provider-field-group .field-hint')?.textContent?.trim() ?? '',
        modelIds,
      }
    })

    assert.equal(form.title, 'Perplexity Agent API')
    assert.equal(form.baseUrl, 'https://api.perplexity.ai/v1')
    assert.equal(form.baseUrlReadOnly, true)
    assert.match(form.keyHint, /web search enabled/i)
    assert.deepEqual(form.modelIds, ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-4-6'])

    await saveElementScreenshot('#settings-dialog', 'settings-perplexity-agent-provider.png')
  })
})
