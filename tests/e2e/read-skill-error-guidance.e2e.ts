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

    const failedTool = $('.tool-card[data-status="error"]')
    await failedTool.waitForDisplayed({ timeout: 10_000 })
    await failedTool.$('summary.tool-card-header').click()
    await expect(failedTool).toHaveText('Unknown skill "pstack"', {
      containing: true,
      wait: 10_000,
    })
    await expect(failedTool).toHaveText('Available skills:', { containing: true })
    await expect(failedTool).toHaveText('checkup', { containing: true })
    await saveElementScreenshot(
      '.tool-card[data-status="error"]',
      'read-skill-unknown-guidance.png',
    )
  })
})
