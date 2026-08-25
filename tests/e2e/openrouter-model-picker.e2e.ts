import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, $$, browser } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'

const OPENROUTER_FIXTURE_PORT = 51235

// Mimics OpenRouter's /models payload: a free tool-capable model, a free model
// without tool support (filtered out), paid tool-capable models (shown when
// free mode is off), and a non-text generator (filtered out).
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
      architecture: { modality: 'text+image->text' },
    },
    {
      id: 'google/gemini-2.5-pro',
      name: 'Gemini 2.5 Pro (paid)',
      context_length: 1048576,
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      supported_parameters: ['tools'],
      architecture: { modality: 'text->text' },
    },
  ],
}

async function startOpenRouterModelServer(): Promise<{
  apiBase: string
  localServerUrl: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/lm/v1/chat/completions')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'A dark settings panel with a Sources section.' }, finish_reason: null }] })}\n\n`,
      )
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    if (url.endsWith('/lm/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3-vl' }] }))
      return
    }
    if (url.endsWith('/lm/api/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [{ key: 'qwen/qwen3-vl', capabilities: { vision: true } }],
        }),
      )
      return
    }
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
    localServerUrl: `http://127.0.0.1:${String(OPENROUTER_FIXTURE_PORT)}/lm/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

describe('OpenRouter model picker', () => {
  let fixture: { apiBase: string; localServerUrl: string; close: () => Promise<void> } | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    fixture = await startOpenRouterModelServer()
    resetUserData()
    seedOpenRouterFixture(process.cwd(), {
      apiBase: fixture.apiBase,
      localServerUrl: fixture.localServerUrl,
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (fixture) await fixture.close()
  })

  it('starts with recent models and opens the full catalog on demand', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    await $('.model-picker-trigger').click()
    await $('.model-picker-menu .model-picker-option').waitForExist({ timeout: 15_000 })

    const recent = await browser.execute(() => {
      const groupLabels = [
        ...document.querySelectorAll<HTMLElement>('.model-picker-group-label'),
      ].map((el) => el.textContent?.trim())
      const optionLabels = [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((el) => el.textContent?.trim() ?? '')
      const title = document.querySelector<HTMLElement>('.model-picker-view-title')?.textContent
      return { groupLabels, optionLabels, title: title?.trim() }
    })

    assert.equal(recent.title, 'Recent')
    assert.deepEqual(recent.groupLabels, [])
    assert.deepEqual(recent.optionLabels, ['Qwen3 235B A22B (free)', 'Claude Sonnet 3.5 (paid)'])
    assert.ok(!recent.optionLabels.includes('Gemini 2.5 Pro (paid)'))

    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-menu.png')

    await $('.model-picker-browse').click()
    await $('.model-picker-filter').waitForDisplayed()

    const picker = await browser.execute(() => {
      const groupLabels = [
        ...document.querySelectorAll<HTMLElement>('.model-picker-group-label'),
      ].map((el) => el.textContent?.trim())
      const optionLabels = [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((el) => el.textContent?.trim() ?? '')
      return { groupLabels, optionLabels }
    })

    // ZDR-only routing is on by default, so the group heading carries the
    // routing-state annotation (see @copse/llm/data-policies.ts).
    assert.ok(
      picker.groupLabels.includes('OpenRouter (ZDR routing)'),
      `expected an OpenRouter (ZDR routing) group, saw ${JSON.stringify(picker.groupLabels)}`,
    )
    assert.ok(
      picker.optionLabels.includes('Qwen3 235B A22B (free)'),
      `expected the free Qwen model, saw ${JSON.stringify(picker.optionLabels)}`,
    )
    assert.ok(
      picker.optionLabels.includes('Claude Sonnet 3.5 (paid)'),
      `expected the paid Claude model, saw ${JSON.stringify(picker.optionLabels)}`,
    )
    assert.ok(
      picker.optionLabels.includes('Gemini 2.5 Pro (paid)'),
      `expected the paid Gemini model, saw ${JSON.stringify(picker.optionLabels)}`,
    )
    assert.ok(
      !picker.optionLabels.some((l) => l.includes('GLM 4.5 Air')),
      'free model without tool support should be filtered out',
    )
    assert.ok(
      !picker.optionLabels.some((l) => l.includes('(custom)')),
      'custom id that matches the live catalog should not duplicate',
    )

    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-all.png')
    await browser.keys('Escape')
    await $('.model-picker-filter').waitForDisplayed({ reverse: true })
    await browser.keys('Escape')
    await $('.model-picker-menu').waitForDisplayed({ reverse: true })
  })

  it('moves the highlighted model with arrow keys and applies it with Enter', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    // Prior specs may leave the menu open; the trigger toggles, so close first.
    await browser.keys('Escape')
    await $('.model-picker-menu').waitForDisplayed({ reverse: true, timeout: 2_000 })
    await $('.model-picker-trigger').click()
    await $('.model-picker-menu .model-picker-option').waitForDisplayed({ timeout: 5_000 })
    assert.equal(
      await browser.execute(() =>
        document.activeElement?.classList.contains('model-picker-option'),
      ),
      true,
      'the current recent model should be focused when the picker opens',
    )

    const initialOptions = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((option) => ({
        text: option.textContent?.trim() ?? '',
        active: option.getAttribute('aria-selected'),
      })),
    )
    assert.deepEqual(
      initialOptions,
      [
        { text: 'Qwen3 235B A22B (free)', active: 'true' },
        { text: 'Claude Sonnet 3.5 (paid)', active: 'false' },
      ],
      'the currently applied model should be highlighted when the picker opens',
    )

    await browser.keys('ArrowDown')
    const afterArrow = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((option) => ({
        text: option.textContent?.trim() ?? '',
        active: option.getAttribute('aria-selected'),
        hasActiveClass: option.classList.contains('is-active'),
      })),
    )
    assert.deepEqual(afterArrow, [
      { text: 'Qwen3 235B A22B (free)', active: 'false', hasActiveClass: false },
      { text: 'Claude Sonnet 3.5 (paid)', active: 'true', hasActiveClass: true },
    ])
    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-keyboard.png')

    // prepareE2eScreenshot can steal focus; put it back before applying.
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.model-picker-option.is-active')?.focus()
    })
    await browser.keys('Enter')
    await $('.model-picker-menu').waitForDisplayed({ reverse: true, timeout: 5_000 })
    assert.equal((await $('.model-picker-label').getText()).trim(), 'Claude Sonnet 3.5 (paid)')
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
    await $('.model-picker-browse').click()
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
      async () => (await $$('.model-picker-option').map((option) => option.getText())).length === 2,
      { timeout: 2_000, timeoutMsg: 'model picker did not filter after typing' },
    )
    assert.deepEqual(await $$('.model-picker-option').map((option) => option.getText()), [
      'Qwen3 235B A22B (free)',
      'qwen/qwen3-vl',
    ])
    assert.deepEqual(await $$('.model-picker-group-label').map((label) => label.getText()), [
      'OPENROUTER (ZDR ROUTING)',
      'LOCAL MODELS',
    ])

    await filter.setValue('no-such-model')
    await $('.model-picker-empty').waitForDisplayed()
    assert.equal((await $('.model-picker-empty').getText()).trim(), 'No matching models')
    assert.equal((await $$('.model-picker-option')).length, 0)

    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-filter.png')

    await browser.keys('Escape')
    await $('.model-picker-filter').waitForDisplayed({ reverse: true })
    await browser.keys('Escape')
    await $('.model-picker-menu').waitForDisplayed({ reverse: true })
    assert.equal(
      await browser.execute(() => document.activeElement?.classList.contains('prompt-input')),
      true,
      'composer should be focused after dismissing the picker with Escape',
    )
  })

  it('warns before sending an image to an incompatible model and offers recovery', async () => {
    await browser.keys('Escape')
    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    await $('.model-picker-filter').setValue('qwen')
    const qwen = await $('.model-picker-option[data-value="openrouter:qwen/qwen3-235b-a22b:free"]')
    await qwen.waitForDisplayed({ timeout: 5_000 })
    await qwen.click()
    await $('.model-picker-menu').waitForDisplayed({ reverse: true, timeout: 5_000 })

    await browser.execute(() => {
      const composer = document.querySelector<HTMLElement>('.prompt-input')
      if (!composer) return
      composer.textContent = 'Can you check whether this screen matches the colour section?'
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nB8AAAAASUVORK5CYII=',
        ),
        (char) => char.charCodeAt(0),
      )
      const transfer = new DataTransfer()
      transfer.items.add(new File([png], 'settings.png', { type: 'image/png' }))
      document.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      )
    })

    await $('.attachment-chips .image-chip').waitForDisplayed({ timeout: 5_000 })
    const warning = await $('.composer-image-warning')
    await warning.waitForDisplayed({ timeout: 10_000 })
    assert.match(await warning.getText(), /Qwen3 235B A22B \(free\) can’t read image input/)
    assert.match(await warning.getText(), /Use Claude Sonnet 3.5 \(paid\)/)
    assert.match(await warning.getText(), /Describe locally with qwen\/qwen3-vl/)
    await expect(await $('.composer-image-describe-btn').isDisplayed()).toBe(true)
    await expect(await $('.composer-image-without-btn').isDisplayed()).toBe(true)

    await $('.submit-btn').click()
    await browser.pause(150)
    assert.equal(await warning.isDisplayed(), true, 'send should stay blocked at the composer')
    assert.equal(
      await $('.prompt-input').getText(),
      'Can you check whether this screen matches the colour section?',
    )
    assert.equal(await $$('.attachment-chips .image-chip').length, 1)

    await saveAppScreenshot('image-model-compatibility-warning.png')

    await $('.composer-image-describe-btn').click()
    await warning.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'described image was not handed to the selected text-only model',
    })
    assert.equal(
      (await $('.model-picker-label').getText()).trim(),
      'Qwen3 235B A22B (free)',
      'description handoff must preserve the original target model',
    )
    assert.equal(await $$('.attachment-chips .image-chip').length, 0)
    const handedOff = await $$('.messages-list .msg-user .message-text')[1]?.getText()
    assert.match(handedOff ?? '', /Image description generated by qwen\/qwen3-vl/)
    assert.match(handedOff ?? '', /Mock response to: \(complex input\)/)
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
    await $('.provider-form input[name="openRouterFreeMode"]').waitForExist({ timeout: 5_000 })

    const fields = await browser.execute(() => ({
      hasOpenRouterKey: !!document.querySelector('.provider-form input[type="password"]'),
      hasCustomModel: !!document.querySelector('.provider-form input[name="openRouterModel"]'),
      hasFreeModeToggle: !!document.querySelector(
        '.provider-form input[name="openRouterFreeMode"]',
      ),
      freeModeChecked:
        document.querySelector<HTMLInputElement>('.provider-form input[name="openRouterFreeMode"]')
          ?.checked ?? false,
      customModelValue:
        document.querySelector<HTMLInputElement>('.provider-form input[name="openRouterModel"]')
          ?.value ?? '',
    }))

    assert.equal(fields.hasOpenRouterKey, true)
    assert.equal(fields.hasCustomModel, true)
    assert.equal(fields.hasFreeModeToggle, true)
    assert.equal(fields.freeModeChecked, false)
    assert.equal(fields.customModelValue, 'anthropic/claude-3.5-sonnet')

    await saveElementScreenshot('#settings-dialog', 'openrouter-settings-fields.png')
  })
})
