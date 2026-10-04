import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const HOST = '.footer-model-host'
const MENU = HOST + ' .model-picker-menu'
const FILTER = HOST + ' .model-picker-filter'
const TRIGGER = HOST + ' .model-picker-trigger'

async function chooseCoverage(value: string): Promise<void> {
  await $(MENU + ' [data-coverage="' + value + '"]').click()
}

async function geometry(): Promise<{
  top: number
  left: number
  right: number
  height: number
  filterTop: number
}> {
  return browser.execute(() => {
    const menu = document.querySelector('.footer-model-host .model-picker-menu')
    const filters = menu?.querySelector('.model-picker-coverage-filters')
    if (!menu || !filters) throw new Error('Missing picker')
    const rect = menu.getBoundingClientRect()
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      height: rect.height,
      filterTop: filters.getBoundingClientRect().top,
    }
  })
}

describe('coverage in the real composer model picker', () => {
  before(async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(TRIGGER).waitForDisplayed()
    // Supply discovery data at the existing API boundary. The real composer,
    // catalog loader, picker, selection persistence, and styles remain in use.
    await browser.execute(() => {
      const getSetting = window.api.settings.get
      window.api.settings.get = async (key): ReturnType<typeof window.api.settings.get> =>
        key === 'registeredAcpAgents'
          ? [
              {
                id: 'claude-acp',
                title: 'Claude Code',
                command: 'claude-agent-acp',
                enabled: true,
                availableModels: [{ value: 'sonnet', label: 'Claude Sonnet 4.6' }],
              },
            ]
          : getSetting(key)
      window.api.settings.availableProviders = async (): ReturnType<
        typeof window.api.settings.availableProviders
      > => ({
        anthropic: true,
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
      window.api.lmStudio.models = async (): ReturnType<typeof window.api.lmStudio.models> => [
        'qwen-local',
      ]
      window.api.lmStudio.modelInfo = async (): ReturnType<
        typeof window.api.lmStudio.modelInfo
      > => [{ id: 'qwen-local', supportsImages: false }]
      window.api.usage.getPlanUsage = async (): ReturnType<
        typeof window.api.usage.getPlanUsage
      > => ({
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
  })

  it('opens from Recent, combines filters and search without moving the controls, and selects by keyboard', async () => {
    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    await $(MENU + ' [data-coverage="local"]').waitForDisplayed()
    await chooseCoverage('local')
    // The current pinned local route remains selectable even when discovery
    // no longer advertises it. Search for the available route explicitly.
    await $(FILTER).setValue('qwen-local')
    await expect($$(MENU + ' .model-picker-option')).toBeElementsArrayOfSize(1)
    const initial = await geometry()
    await $(FILTER).setValue('no model matches this')
    await expect($(MENU + ' .model-picker-empty')).toHaveText('No matching models')
    expect(await geometry()).toEqual(initial)
    await $(FILTER).setValue('')
    for (const coverage of ['plan', 'paid', 'all', 'local']) {
      await chooseCoverage(coverage)
      expect(await geometry()).toEqual(initial)
    }
    await $(FILTER).setValue('qwen-local')
    await $(FILTER).click()
    await browser.keys('Enter')
    await expect($(MENU)).not.toBeDisplayed()
    await expect($(TRIGGER + ' .model-picker-label')).toHaveText('Qwen Local')
    await expect($(TRIGGER + ' .model-picker-cost')).not.toBeDisplayed()
  })

  it('aligns the selected tick in Recent and shows plan coverage through the real loader', async () => {
    await $(TRIGGER).click()
    const selected = MENU + ' .model-picker-option[aria-current="true"]'
    await expect($(selected + ' .model-picker-coverage-label')).toHaveText('Local')
    const alignment = await browser.execute(() => {
      const row = document.querySelector(
        '.footer-model-host .model-picker-option[aria-current="true"]',
      )
      const tick = row?.querySelector('.model-picker-option-check')?.getBoundingClientRect()
      const badge = row?.querySelector('.model-picker-coverage-label')?.getBoundingClientRect()
      if (!tick || !badge) throw new Error('Missing selected tick or local label')
      return Math.abs(tick.top + tick.height / 2 - badge.top - badge.height / 2)
    })
    expect(alignment).toBeLessThanOrEqual(1)
    await saveElementScreenshot(MENU, 'model-picker-coverage-recent.png')
    await $(MENU + ' .model-picker-browse').click()
    await chooseCoverage('plan')
    await expect($$(MENU + ' .model-picker-option')).toBeElementsArrayOfSize(1)
    await expect($(MENU + ' .model-picker-coverage-label')).toHaveText('Plan')
    await $(MENU + ' .model-picker-option').click()
    await expect($(MENU)).not.toBeDisplayed()
    await expect($(TRIGGER + ' .model-picker-cost')).not.toBeDisplayed()
  })

  it('marks API selections with a dollar badge and keeps the menu usable in both themes', async () => {
    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    await chooseCoverage('paid')
    await $(FILTER).setValue('Sonnet 4.6')
    await $(MENU + ' .model-picker-option').click()
    await expect($(TRIGGER + ' .model-picker-cost')).toBeDisplayed()
    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    await expect($(MENU + ' [data-coverage="all"]')).toHaveAttribute('aria-pressed', 'true')
    for (const theme of ['dark', 'light']) {
      await browser.execute((value) => {
        document.documentElement.dataset['theme'] = value
      }, theme)
      if (theme === 'dark') await saveElementScreenshot(MENU, 'model-picker-coverage-dark.png')
      else await saveElementScreenshot(MENU, 'model-picker-coverage-light.png')
    }
    expect(await $(MENU).getText()).not.toContain('No known plan or local coverage')
    await browser.keys('Escape')
    await browser.keys('Escape')
    await expect($(MENU)).not.toBeDisplayed()
    // Screenshot framing pins #app to 800px tall. Release that capture frame
    // before shrinking the window so the composer follows the real viewport.
    await browser.execute(() => {
      const app = document.getElementById('app')!
      app.style.removeProperty('width')
      app.style.removeProperty('height')
    })
    await browser.setWindowSize(800, 700)
    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    const narrow = await geometry()
    expect(narrow.left).toBeGreaterThanOrEqual(0)
    expect(narrow.right).toBeLessThanOrEqual(800)
    await chooseCoverage('local')
    await $(MENU + ' .model-picker-option').click()
    await expect($(TRIGGER + ' .model-picker-cost')).not.toBeDisplayed()
  })
})
