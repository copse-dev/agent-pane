import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('tool argument error guidance', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'tool-argument-error-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the invalid todo field and retry guidance without a schema JSON dump', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // Exercise the real registry and agent-loop error path with the reported
    // smaller-model mistake: a todo missing its required content field.
    await setComposerValue('[[mcp:update_todos {"todos":[{"status":"pending"}]}]]')
    await $('.submit-btn').click()
    await waitForAgentIdle(30_000)

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
    await expect(failedTool).toHaveText('todos[0].content', { containing: true })
    await expect(failedTool).toHaveText('expected string, received undefined', {
      containing: true,
    })
    await expect(failedTool).toHaveText('Correct them and call the tool again.', {
      containing: true,
    })
    const text = await failedTool.getText()
    expect(text).not.toContain('invalid_type')
    expect(text).not.toContain('"expected"')
    await saveElementScreenshot(
      '.tool-card[data-tool-id][data-status="error"]',
      'tool-argument-error-guidance.png',
    )
  })
})
