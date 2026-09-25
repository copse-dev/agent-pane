import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedE2eViewport } from './helpers/seed-config.ts'
import { prepareMockTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('Process manager agent activity', function () {
  this.timeout(90_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-process-manager-agent-activity')
    seedE2eViewport()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows a live turn with no thread-owned process and clears it on completion', async () => {
    const threadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(threadId)
    const scenario = await prepareMockTurn(
      'Explain the process manager activity.',
      [{ waitFor: 'inspection', text: 'The process manager shows live agent activity.' }],
      true,
    )
    await submitComposer()
    await browser.waitUntil(async () => $('.stop-btn').isDisplayed(), {
      timeout: 15_000,
      timeoutMsg: 'expected the agent run to start',
    })
    await scenario.waitForHold('inspection')

    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    const dialog = $('#process-manager-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    const activity = dialog.$(`.process-manager-activity-item[data-thread-id="${threadId}"]`)
    await activity.waitForDisplayed({ timeout: 10_000 })
    await expect(activity).toHaveText(expect.stringContaining('Working'))
    assert.equal(
      await dialog.$(`.process-manager-rows tr[data-thread-id="${threadId}"]`).isExisting(),
      false,
    )
    await saveAppScreenshot('process-manager-agent-working.png')

    await scenario.release('inspection')
    await waitForAgentIdle(15_000)
    await browser.waitUntil(async () => !(await activity.isExisting()), { timeout: 8_000 })
    await expect(dialog.$('.process-manager-activity')).not.toBeDisplayed()
  })
})
