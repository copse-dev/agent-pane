import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const HOST = '.footer-model-host'
const MENU = HOST + ' .model-picker-menu'
const FILTER = HOST + ' .model-picker-filter'
const TRIGGER = HOST + ' .model-picker-trigger'

/**
 * A single ACP agent (a Claude Code subscription route) that advertises both
 * Sonnet 5 and Sonnet 5.5. Same-agent suppression should hide the older
 * release exactly like the Cloud models group does, since the two are not a
 * different agent or a different billing route — just two releases of one
 * agent's own catalog.
 */
async function installClaudeCodeFixture(): Promise<void> {
  await browser.execute(() => {
    const getSetting = window.api.settings.get
    window.api.settings.get = async (key) =>
      key === 'registeredAcpAgents'
        ? [
            {
              id: 'claude-acp',
              title: 'Claude Code',
              command: 'claude-agent-acp',
              enabled: true,
              availableModels: [
                {
                  value: 'sonnet',
                  label: 'Sonnet',
                  description: 'Sonnet 5 · Efficient for routine tasks',
                },
                {
                  value: 'sonnet[1m]',
                  label: 'Sonnet (1M context)',
                  description: 'Sonnet 5.5 with 1M context · Efficient for routine tasks',
                },
              ],
            },
          ]
        : getSetting(key)
    window.api.settings.availableProviders = async () => ({
      anthropic: false,
      openai: false,
      'openai:gpt-6-astra': false,
      cursor: false,
      openrouter: false,
      perplexity: false,
      mistral: false,
      gemini: false,
      deepseek: false,
      huggingface: false,
    })
    window.api.settings.extraProviders = async () => []
    window.api.lmStudio.models = async () => []
    // Plan coverage for an ACP route needs a reported subscription plan.
    window.api.usage.getPlanUsage = async () => ({
      checkedAt: '2026-10-01T00:00:00Z',
      providers: [
        {
          provider: 'claude',
          status: 'ok',
          usage: {
            provider: 'claude',
            plan: 'Max',
            checkedAt: '2026-10-01T00:00:00Z',
            windows: [{ id: 'seven_day', label: 'Weekly', usedPercent: 20, resetsAt: null }],
          },
        },
      ],
    })
  })
}

describe('superseded ACP model versions in the model picker (browser-hosted)', () => {
  it('hides the older same-agent release from Plan coverage', async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(TRIGGER).waitForDisplayed()
    await installClaudeCodeFixture()

    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    await $(MENU + ' [data-coverage="plan"]').waitForDisplayed()
    await $(MENU + ' [data-coverage="plan"]').click()
    await $(FILTER).setValue('Sonnet')

    const newest = $(MENU + ' .model-picker-option[data-value="acp:claude-acp#sonnet[1m]"]')
    await expect(newest).toBeDisplayed()
    await expect(newest).toBeEnabled()
    await expect(
      $(MENU + ' .model-picker-option[data-value="acp:claude-acp#sonnet"]'),
    ).not.toExist()
    await saveElementScreenshot(MENU, 'model-version-suppression-acp-after.png')
    await browser.keys('Escape')
  })
})
