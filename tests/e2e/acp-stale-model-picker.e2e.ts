import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const STALE_MODEL = 'acp:cursor#composer-2.5[fast=true]'

describe('ACP stale model picker label', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-stale-model-project', {
      model: STALE_MODEL,
      registeredAcpAgents: [
        {
          id: 'cursor',
          title: 'Cursor',
          command: 'cursor-agent',
          args: ['acp'],
          enabled: true,
          availableModels: [{ value: 'composer-2.5[fast=false]', label: 'Composer 2.5' }],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('identifies an unadvertised model without calling Cursor unconfigured', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    const trigger = await $('.model-picker-trigger')
    await trigger.click()
    const menu = await $('.model-picker-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })

    const labels = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLElement>('.model-picker-menu .model-picker-option-label'),
      ].map((element) => element.textContent?.trim() ?? ''),
    )
    assert.ok(
      labels.includes('Cursor — composer-2.5[fast=true] (not currently advertised)'),
      `expected stale-model explanation, saw ${JSON.stringify(labels)}`,
    )
    assert.ok(!labels.some((label) => label.includes('not configured')))

    await saveElementScreenshot(menu, 'acp-stale-model-picker.png')
  })
})
