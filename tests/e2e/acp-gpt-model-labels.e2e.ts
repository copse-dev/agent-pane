import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('ACP GPT model picker labels', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-gpt-model-labels', {
      windowBounds: { width: 1280, height: 800 },
      model: 'acp:codex-acp#gpt-5.6-sol',
      registeredAcpAgents: [
        {
          id: 'codex-acp',
          title: 'Codex',
          command: 'codex-acp',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano' },
            { value: 'gpt-5.1', label: 'gpt-5.1' },
            { value: 'gpt-5-mini', label: 'gpt-5-mini' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('uses one display style for raw ids and friendly agent labels', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    const filter = await $('.model-picker-filter')
    await filter.waitForDisplayed({ timeout: 5_000 })
    await filter.setValue('gpt')

    const menu = await $('.model-picker-menu')
    const labels = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLElement>('.model-picker-menu .model-picker-option-label'),
      ].map((element) => element.textContent?.trim() ?? ''),
    )
    const names = labels.map((label) => label.replace(/\s+— intellect [\d.]+$/, ''))
    for (const expected of ['GPT-5.4 nano', 'GPT-5.1', 'GPT-5 mini', 'GPT-5.6 Sol']) {
      assert.ok(names.includes(expected), `expected ${expected}, saw ${JSON.stringify(labels)}`)
    }
    assert.ok(!labels.some((label) => /^gpt-/.test(label)), JSON.stringify(labels))

    await saveElementScreenshot(menu, 'acp-gpt-model-labels.png')
  })
})
