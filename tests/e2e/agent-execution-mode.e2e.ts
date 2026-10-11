import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

describe('agent execution mode in the composer', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-agent-execution-mode', {
      windowBounds: { width: 1280, height: 800 },
      model: 'acp:fixture-agent',
      registeredAcpAgents: [
        {
          id: 'fixture-agent',
          title: 'Fixture Agent',
          command: 'fixture-acp',
          enabled: true,
          configOptions: { mode: 'plan' },
          availableConfigOptions: [
            {
              configId: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'plan',
              choices: [
                { value: 'plan', label: 'Plan' },
                { value: 'auto', label: 'Auto' },
              ],
            },
          ],
        },
      ],
    })
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: 'e2e-agent-execution-mode', path: process.cwd(), name: 'workspace' }],
      activeProjectId: 'e2e-agent-execution-mode',
      activeThreadId: 'agent-execution-mode-thread',
      'threads:e2e-agent-execution-mode': [
        {
          id: 'agent-execution-mode-thread',
          title: 'Agent execution mode',
          status: 'idle',
          model: 'acp:fixture-agent',
          messages: [
            {
              id: 'agent-execution-mode-user',
              role: 'user',
              content: 'Work on this project.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps Copse managed quiet and shows Agent managed after selection', async () => {
    await expect($('.agent-execution-mode-badge')).not.toBeDisplayed()
    await $('.model-picker-trigger').click()
    await expect($('.model-picker-group-row*=Mode')).toBeDisplayed()
    await $('.model-picker-trigger').click()
    await $('.footer-overflow-trigger').click()
    const modeItem = $('.footer-overflow-item*=Execution mode…')
    await expect(modeItem).toBeDisplayed()
    await modeItem.click()
    await expect($('.agent-execution-mode-dialog')).toBeDisplayed()
    await expect($('.agent-execution-mode-option[data-mode="copse"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await saveElementScreenshot('.agent-execution-mode-dialog', 'agent-execution-mode-dialog.png', {
      frame: 'document',
    })
    await $('.agent-execution-mode-option[data-mode="agent"]').click()
    await $('.agent-execution-mode-apply').click()
    await expect($('.agent-execution-mode-badge')).toBeDisplayed()
    await expect($('.agent-execution-mode-badge')).toHaveText('Agent managed')
    await $('.model-picker-trigger').click()
    await expect($('.model-picker-group-row*=Mode')).not.toExist()
    await $('.model-picker-trigger').click()
    await saveAppScreenshot('agent-execution-mode-active.png')
    await browser.reloadSession()
    await expect($('.agent-execution-mode-badge')).toBeDisplayed()
    await expect($('.agent-execution-mode-badge')).toHaveText('Agent managed')
  })
})
