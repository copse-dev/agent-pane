import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'

const OPENROUTER_FIXTURE_PORT = 51235

// Mimics OpenRouter's /models payload: a free tool-capable model (shown), a free
// model without tool support (filtered out), a paid model (filtered out), and a
// non-text generator (filtered out).
const MODELS_PAYLOAD = {
  data: [
    {
      id: 'qwen/qwen3-235b-a22b:free',
      name: 'Qwen3 235B A22B (free)',
      context_length: 262144,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'temperature'],
      architecture: { modality: 'text->text', output_modalities: ['text'] },
    },
    {
      id: 'z-ai/glm-4.5-air:free',
      name: 'GLM 4.5 Air (free, no tools)',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['temperature'],
      architecture: { modality: 'text->text' },
    },
    {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Claude 3.5 Sonnet (paid)',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools'],
      architecture: { modality: 'text->text' },
    },
  ],
}

async function startOpenRouterModelServer(): Promise<{
  apiBase: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_PAYLOAD))
      return
    }
    // `/key` is the auth probe validateOpenRouterApiKey hits before the picker
    // will list the provider; 200 marks the seeded fixture key as usable.
    if (url.endsWith('/key')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { label: 'e2e-key', usage: 0, limit: null } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const apiBase = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(OPENROUTER_FIXTURE_PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${OPENROUTER_FIXTURE_PORT}/api/v1`)
    })
  })
  return {
    apiBase,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

describe('OpenRouter model picker', () => {
  let fixture: { apiBase: string; close: () => Promise<void> } | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    fixture = await startOpenRouterModelServer()
    resetUserData()
    seedOpenRouterFixture(process.cwd(), { apiBase: fixture.apiBase })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (fixture) await fixture.close()
  })

  it('lists only free tool-capable models from the live catalog, plus the custom id', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    await $('.model-picker-trigger').click()
    await $('.model-picker-menu .model-picker-option').waitForExist({ timeout: 15_000 })

    const picker = await browser.execute(() => {
      const groupLabels = [
        ...document.querySelectorAll<HTMLElement>('.model-picker-group-label'),
      ].map((el) => el.textContent?.trim())
      const optionLabels = [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((el) => el.textContent?.trim() ?? '')
      return { groupLabels, optionLabels }
    })

    assert.ok(
      picker.groupLabels.includes('OpenRouter'),
      `expected an OpenRouter group, saw ${JSON.stringify(picker.groupLabels)}`,
    )
    // Free + tool-capable model is offered.
    assert.ok(
      picker.optionLabels.includes('Qwen3 235B A22B (free)'),
      `expected the free Qwen model, saw ${JSON.stringify(picker.optionLabels)}`,
    )
    // Free-but-no-tools and paid models are filtered out.
    assert.ok(
      !picker.optionLabels.some((l) => l.includes('GLM 4.5 Air')),
      'free model without tool support should be filtered out',
    )
    assert.ok(
      !picker.optionLabels.some((l) => l.includes('(paid)')),
      'paid models should be filtered out',
    )
    // The custom id from Settings is still offered.
    assert.ok(
      picker.optionLabels.some((l) => l === 'anthropic/claude-3.5-sonnet (custom)'),
      `expected the custom model, saw ${JSON.stringify(picker.optionLabels)}`,
    )

    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-menu.png')
  })

  it('moves the highlighted model with arrow keys and applies it with Enter', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('.model-picker-trigger').click()
    const filter = await $('.model-picker-filter')

    assert.deepEqual(
      await $('.model-picker-option').map(async (option) => ({
        text: await option.getText(),
        active: await option.getAttribute('aria-selected'),
      })),
      [
        { text: 'Qwen3 235B A22B (free)', active: 'true' },
        { text: 'anthropic/claude-3.5-sonnet (custom)', active: 'false' },
      ],
      'the currently applied model should be highlighted when the picker opens',
    )

    await filter.keys('ArrowDown')
    assert.deepEqual(
      await $('.model-picker-option').map(async (option) => ({
        text: await option.getText(),
        active: await option.getAttribute('aria-selected'),
        hasActiveClass: await option
          .getAttribute('class')
          .then((classes) => classes?.includes('is-active')),
      })),
      [
        { text: 'Qwen3 235B A22B (free)', active: 'false', hasActiveClass: false },
        {
          text: 'anthropic/claude-3.5-sonnet (custom)',
          active: 'true',
          hasActiveClass: true,
        },
      ],
    )
    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-keyboard.png')

    await filter.keys('Enter')
    await $('.model-picker-menu').waitForDisplayed({ reverse: true })
    assert.equal((await $('.model-picker-label').getText()).trim(), 'anthropic/claude-3.5-sonnet')
    assert.equal(
      await browser.execute(() => document.activeElement?.classList.contains('prompt-input')),
      true,
      'composer should be focused after closing the picker',
    )
  })

  it('filters visible models immediately as text is entered', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await browser.keys('Escape')
    await $('.model-picker-trigger').click()
    const filter = await $('.model-picker-filter')
    assert.equal(
      await browser.execute(() =>
        document.activeElement?.classList.contains('model-picker-filter'),
      ),
      true,
      'filter should be focused when the picker opens',
    )

    await filter.setValue('qwen')
    await browser.waitUntil(
      async () => (await $$('.model-picker-option').map((option) => option.getText())).length === 1,
      { timeout: 2_000, timeoutMsg: 'model picker did not filter after typing' },
    )
    assert.deepEqual(await $$('.model-picker-option').map((option) => option.getText()), [
      'Qwen3 235B A22B (free)',
    ])
    assert.deepEqual(await $$('.model-picker-group-label').map((label) => label.getText()), [
      'OPENROUTER',
    ])

    await filter.setValue('no-such-model')
    await $('.model-picker-empty').waitForDisplayed()
    assert.equal((await $('.model-picker-empty').getText()).trim(), 'No matching models')
    assert.equal((await $$('.model-picker-option')).length, 0)

    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-filter.png')

    await browser.keys('Escape')
    await $('.model-picker-menu').waitForDisplayed({ reverse: true })
    assert.equal(
      await browser.execute(() => document.activeElement?.classList.contains('prompt-input')),
      true,
      'composer should be focused after dismissing the picker with Escape',
    )
  })

  it('exposes an OpenRouter API key field and custom model input in the OpenRouter provider form', async () => {
    await browser.keys('Escape')
    await $('[aria-label="Settings"]').click()
    await $('.settings-section[data-section="general"]').waitForExist({ timeout: 15_000 })

    // The key and custom-model fields live inside the OpenRouter provider form,
    // shown only once its chip is selected in the Providers panel.
    const selected = await browser.execute(() => {
      const chip = [...document.querySelectorAll<HTMLButtonElement>('.provider-chip')].find(
        (el) => el.textContent?.trim() === 'OpenRouter',
      )
      chip?.click()
      return !!chip
    })
    assert.equal(selected, true, 'expected an OpenRouter provider chip')

    await $('.provider-form input[name="openRouterModel"]').waitForExist({ timeout: 5_000 })

    const fields = await browser.execute(() => ({
      hasOpenRouterKey: !!document.querySelector('.provider-form input[type="password"]'),
      hasCustomModel: !!document.querySelector('.provider-form input[name="openRouterModel"]'),
      customModelValue:
        document.querySelector<HTMLInputElement>('.provider-form input[name="openRouterModel"]')
          ?.value ?? '',
    }))

    assert.equal(fields.hasOpenRouterKey, true)
    assert.equal(fields.hasCustomModel, true)
    assert.equal(fields.customModelValue, 'anthropic/claude-3.5-sonnet')

    await saveElementScreenshot('#settings-dialog', 'openrouter-settings-fields.png')
  })
})
