import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('default Anthropic cloud model', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-e2e-sonnet-5-5'
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-cloud-model-default', {
      model: 'auto:best-value',
      subagentsEnabled: false,
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    delete process.env.ANTHROPIC_API_KEY
  })

  it('lists Sonnet 5.5 before the retained Sonnet 5 and 4.6 options', async () => {
    const picker = $('.footer-model-host .model-picker')
    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    const menu = picker.$('.model-picker-menu')
    await menu.waitForDisplayed({ timeout: 15_000 })

    const cloudModels = await browser.execute(() => {
      const values: string[] = []
      let inCloudGroup = false
      for (const child of document.querySelectorAll('.footer-model-host .model-picker-list > *')) {
        if (child.classList.contains('model-picker-group-label')) {
          inCloudGroup = child.textContent?.trim() === 'Cloud models'
          continue
        }
        if (!inCloudGroup || !child.classList.contains('model-picker-option')) continue
        const value = child.getAttribute('data-value')
        if (value) values.push(value)
      }
      return values
    })
    expect(cloudModels).toContain('claude-sonnet-5-5')
    expect(cloudModels).toContain('claude-sonnet-5')
    expect(cloudModels).toContain('claude-sonnet-4-6')
    expect(cloudModels.indexOf('claude-sonnet-5-5')).toBeLessThan(
      cloudModels.indexOf('claude-sonnet-5'),
    )
    expect(cloudModels.indexOf('claude-sonnet-5')).toBeLessThan(
      cloudModels.indexOf('claude-sonnet-4-6'),
    )
    const defaultOption = menu.$('[data-value="claude-sonnet-5-5"]')
    await expect(defaultOption).toBeDisplayed()
    await expect(defaultOption).toHaveText('Claude Sonnet 5.5')

    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'cloud-model-default-sonnet-5-5.png',
    )
  })
})
