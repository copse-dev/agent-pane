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
    window.api.settings.get = async (key): ReturnType<typeof getSetting> =>
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
    window.api.settings.availableProviders = async (): ReturnType<
      typeof window.api.settings.availableProviders
    > => ({
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
    window.api.settings.extraProviders = async (): ReturnType<
      typeof window.api.settings.extraProviders
    > => []
    window.api.lmStudio.models = async (): ReturnType<typeof window.api.lmStudio.models> => []
    // Plan coverage for an ACP route needs a reported subscription plan.
    window.api.usage.getPlanUsage = async (): ReturnType<typeof window.api.usage.getPlanUsage> => ({
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

const CODEX_VERSION_MODELS = [
  { value: 'gpt-6', label: 'GPT-6' },
  { value: 'gpt-6.2', label: 'GPT-6.2' },
  { value: 'gpt-6.2-sol', label: '6.2 Sol' },
  { value: 'gpt-6.1-sol', label: '6.1 Sol' },
]

/** A Codex agent advertising `availableModels`; a later call replaces the list. */
async function installCodexVersionFixture(
  availableModels: Array<{ value: string; label: string }> = CODEX_VERSION_MODELS,
): Promise<void> {
  await browser.execute((models) => {
    const getSetting = window.api.settings.get
    window.api.settings.get = async (key): ReturnType<typeof getSetting> =>
      key === 'registeredAcpAgents'
        ? [
            {
              id: 'codex-acp',
              title: 'Codex',
              command: 'codex-acp',
              enabled: true,
              availableModels: models,
            },
          ]
        : getSetting(key)
    window.api.settings.availableProviders = async (): ReturnType<
      typeof window.api.settings.availableProviders
    > => ({
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
    window.api.settings.extraProviders = async (): ReturnType<
      typeof window.api.settings.extraProviders
    > => []
    window.api.lmStudio.models = async (): ReturnType<typeof window.api.lmStudio.models> => []
  }, availableModels)
}

/** Opens the full model list filtered to `query`. */
async function browseModels(query: string): Promise<void> {
  await $(TRIGGER).click()
  await $(MENU + ' .model-picker-browse').click()
  await $(FILTER).setValue(query)
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

  it('shows only GPT-6.2 when the same Codex agent also advertises GPT-6', async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(TRIGGER).waitForDisplayed()
    await installCodexVersionFixture()

    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    await $(FILTER).setValue('GPT-6')

    const latest = $(MENU + ' .model-picker-option[data-value="acp:codex-acp#gpt-6.2"]')
    await expect(latest).toBeDisplayed()
    await expect(latest).toBeEnabled()
    await expect($(MENU + ' .model-picker-option[data-value="acp:codex-acp#gpt-6"]')).not.toExist()
    await saveElementScreenshot(MENU, 'model-version-suppression-acp-gpt-after.png')
    await browser.keys('Escape')
  })

  it('shows only 6.2 Sol when the agent also lists the scored 6.1 Sol', async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(TRIGGER).waitForDisplayed()
    await installCodexVersionFixture()

    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    await $(FILTER).setValue('Sol')

    const latest = $(MENU + ' .model-picker-option[data-value="acp:codex-acp#gpt-6.2-sol"]')
    await expect(latest).toBeDisplayed()
    await expect(latest).toBeEnabled()
    await expect(
      $(MENU + ' .model-picker-option[data-value="acp:codex-acp#gpt-6.1-sol"]'),
    ).not.toExist()
    await saveElementScreenshot(MENU, 'model-version-suppression-acp-sol-after.png')
    await browser.keys('Escape')
  })

  it('names a scored successor by its release name on the saved older row', async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(TRIGGER).waitForDisplayed()
    const saved = MENU + ' .model-picker-option[data-value="acp:codex-acp#gpt-5.6-sol"]'

    // Codex lists 5.6 Sol as its newest release, and the user picks it...
    await installCodexVersionFixture([{ value: 'gpt-5.6-sol', label: '5.6 Sol' }])
    await browseModels('Sol')
    await expect($(saved)).toBeEnabled()
    // ...just as Codex starts advertising 6.1 Sol too. Both releases are
    // scored, so 6.1 Sol's lineage is the intellect catalog's dashed
    // `gpt-6-1-sol`; the reload that follows the pick reads the new list.
    await installCodexVersionFixture([
      { value: 'gpt-6.1-sol', label: '6.1 Sol' },
      { value: 'gpt-5.6-sol', label: '5.6 Sol' },
    ])
    await $(saved).click()
    await expect($(TRIGGER)).toHaveText(/\(superseded by GPT-6\.1 Sol\)/)

    await browseModels('Sol')
    await expect($(saved)).toHaveText(/\(superseded by GPT-6\.1 Sol\)/)
    await expect($(saved)).not.toHaveText(/gpt-6-1-sol/)
    await expect($(saved)).toBeDisabled()
    const successor = $(MENU + ' .model-picker-option[data-value="acp:codex-acp#gpt-6.1-sol"]')
    await expect(successor).toBeDisplayed()
    await expect(successor).toBeEnabled()
    await saveElementScreenshot(MENU, 'model-version-suppression-acp-scored-successor.png')
    await browser.keys('Escape')
  })
})
