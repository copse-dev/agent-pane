import { $, browser, expect } from '@wdio/globals'
import { resetUserData } from './helpers/seed-config.ts'
import { seedProjectConfig, waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('read_skill error guidance', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    await seedProjectConfig(process.cwd(), {
      projectId: 'read-skill-error-project',
      threadId: 'read-skill-error-thread',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('gives an agent valid alternatives after an unknown skill call', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('[[mcp:read_skill {"name":"pstack"}]]')
    await $('.submit-btn').click()
    await waitForAgentIdle(30_000)

    // Live tools retain their turn wrapper even when only one tool ran.
    const rollup = $('.tool-card-rollup[data-status="error"]')
    await rollup.waitForDisplayed({ timeout: 10_000 })
    if (!(await rollup.getProperty('open'))) {
      await rollup.$('summary.tool-card-header').click()
    }
    const failedTool = $('.tool-card[data-tool-id][data-status="error"]')
    await failedTool.waitForDisplayed({ timeout: 10_000 })
    if (!(await failedTool.getProperty('open'))) {
      await failedTool.$('summary.tool-card-header').click()
    }
    await expect(failedTool).toHaveText('Unknown skill "pstack"', {
      containing: true,
      wait: 10_000,
    })
    await expect(failedTool).toHaveText('Available skills:', { containing: true })
    await expect(failedTool).toHaveText('checkup', { containing: true })
    await saveElementScreenshot(
      '.tool-card[data-tool-id][data-status="error"]',
      'read-skill-unknown-guidance.png',
    )
  })
})
