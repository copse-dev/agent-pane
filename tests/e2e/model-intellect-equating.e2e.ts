import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('new index model intelligence', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'intellect-equating-project', {
      model: 'acp:equating-agent#claude-fable-5-1',
      registeredAcpAgents: [
        {
          id: 'equating-agent',
          title: 'Model comparison',
          command: 'equating-agent',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
            { value: 'claude-fable-5', label: 'Claude Fable 5' },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('marks the translated score as an estimate in the model picker', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    const filter = $('.model-picker-filter')
    await filter.waitForDisplayed({ timeout: 5000 })
    await filter.setValue('fable')
    const menu = $('.model-picker-menu')
    await expect(menu).toHaveText('Claude Fable 5.1 — intellect ~69.2', { containing: true })
    await saveElementScreenshot('.model-picker-menu', 'model-intellect-equating.png')
  })
})
