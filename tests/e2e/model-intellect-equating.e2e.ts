import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'

describe('new index model intelligence', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'intellect-equating-project', {
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
    // Synced scores move; the tilde is the stable contract for an equated estimate.
    await expect(menu).toHaveText('Claude Fable 5.1: intellect ~', { containing: true })
    assert.match(await menu.getText(), /Claude Fable 5\.1: intellect ~\d+(\.\d+)?/)
    // The weekly Artificial Analysis sync (sync-intellect.yml) rewrites the
    // number in packages/llm, and that PR owns no screenshot, so an unpinned
    // capture drifts on every later PR that renders the picker.
    const restoreScore = await pinTextForCapture(
      '.model-picker-menu',
      /(?<=intellect ~)\d+(\.\d+)?/g,
      '60.0',
    )
    try {
      await saveElementScreenshot('.model-picker-menu', 'model-intellect-equating.png')
    } finally {
      await restoreScore()
    }
  })
})
