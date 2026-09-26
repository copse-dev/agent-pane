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
    // The chip is rounded with the base radius; it used to name `--radius-md`,
    // which is not a token and computed to square corners (#3065).
    assert.equal((await activity.getCSSProperty('border-top-left-radius')).value, '6px')
    await saveAppScreenshot('process-manager-agent-working.png')

    await dialog.$('[aria-label="Close process manager"]').click()
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await activity.waitForDisplayed({ timeout: 10_000 })
    await browser.keys('Tab')
    await expect(activity).toBeFocused()
    const focusedSample = Number(await dialog.getAttribute('data-sampled-at'))
    await browser.waitUntil(
      async () => Number(await dialog.getAttribute('data-sampled-at')) > focusedSample,
      { timeout: 8_000 },
    )
    await expect(activity).toBeFocused()
    await browser.keys(['Shift', 'F10'])
    await expect($('.context-menu-item=Jump to thread')).toBeDisplayed()
    await expect($('.context-menu-item=Stop agent run')).toBeDisplayed()
    await saveAppScreenshot('process-manager-agent-keyboard.png')
    await browser.keys('Escape')

    await dialog.$('[aria-label="Close process manager"]').click()
    await $('.project-new-thread-btn').click()
    await browser.waitUntil(
      async () => (await $('.chat-row.selected').getAttribute('data-thread-id')) !== threadId,
      { timeout: 10_000 },
    )
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await activity.waitForDisplayed({ timeout: 10_000 })
    await activity.click({ button: 'right' })
    await expect($('.context-menu-item=Jump to thread')).toBeDisplayed()
    await expect($('.context-menu-item=Stop agent run')).toBeDisplayed()
    await saveAppScreenshot('process-manager-agent-actions.png')
    await $('.context-menu-item=Jump to thread').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', threadId)

    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await activity.waitForDisplayed({ timeout: 10_000 })
    await activity.click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', threadId)

    await scenario.release('inspection')
    await waitForAgentIdle(15_000)
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'p'])
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(async () => !(await activity.isExisting()), { timeout: 8_000 })
    await expect(dialog.$('.process-manager-activity')).not.toBeDisplayed()
  })
})
