import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedStableWorkspace } from './helpers/seed-config.ts'
import { seedProjectConfig, waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('read_skill error guidance', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    await seedProjectConfig(seedStableWorkspace(), {
      projectId: 'read-skill-error-project',
      threadId: 'read-skill-error-thread',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  /**
   * Open the newest failed tool card and return a selector unique to it. Both
   * cases run in one thread, so the second must not read the first's card.
   * Failures render beside the turn's rollup rather than inside it, so the card
   * is visible without opening the rollup.
   */
  async function expandLatestFailedTool(): Promise<string> {
    const failedTools = await $$('.tool-card[data-tool-id][data-status="error"]')
    const failedTool = failedTools[failedTools.length - 1]
    if (!failedTool) throw new Error('no failed tool card rendered')
    await failedTool.waitForDisplayed({ timeout: 10_000 })
    await expect(
      $$('.tool-card-rollup .tool-card[data-tool-id][data-status="error"]'),
    ).toBeElementsArrayOfSize(0)
    if (!(await failedTool.getProperty('open'))) {
      await failedTool.$('summary.tool-card-header').click()
    }
    return `.tool-card[data-tool-id="${await failedTool.getAttribute('data-tool-id')}"]`
  }

  it('tells the agent a bundled plugin name is switched off, not unknown', async () => {
    // Models see bundled skills under `.../plugins/pstack/skills/<name>/` and
    // ask for `pstack` itself — the most common failed read_skill in real
    // threads. pstack ships switched off, so the answer names where to turn it on.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await prepareMockToolTurn(
      'Read the pstack skill and explain how to use it.',
      { name: 'read_skill', args: { name: 'pstack' } },
      'pstack is switched off; continuing without it.',
    )
    await submitComposer()
    await waitForAgentIdle(30_000)

    const selector = await expandLatestFailedTool()
    const failedTool = $(selector)
    await expect(failedTool).toHaveText('"pstack" is a bundled plugin that is switched off', {
      containing: true,
      wait: 10_000,
    })
    await expect(failedTool).toHaveText('Settings → Agent → Skills', { containing: true })
    await expect(failedTool).toHaveText('Settings → Customise → Plugins', { containing: true })
    await saveElementScreenshot(selector, 'read-skill-switched-off-plugin-guidance.png')
  })

  it('gives an agent valid alternatives after an unknown skill call', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await prepareMockToolTurn(
      'Read the nonexistent-helper skill and explain how to use it.',
      { name: 'read_skill', args: { name: 'nonexistent-helper' } },
      'The requested skill could not be loaded; the tool result lists the available alternatives.',
    )
    await submitComposer()
    await waitForAgentIdle(30_000)

    const selector = await expandLatestFailedTool()
    const failedTool = $(selector)
    await expect(failedTool).toHaveText('Unknown skill "nonexistent-helper"', {
      containing: true,
      wait: 10_000,
    })
    await expect(failedTool).toHaveText('Available skills:', { containing: true })
    await expect(failedTool).toHaveText('cursor-sdk', { containing: true })
    await saveElementScreenshot(selector, 'read-skill-unknown-guidance.png')
  })
})
