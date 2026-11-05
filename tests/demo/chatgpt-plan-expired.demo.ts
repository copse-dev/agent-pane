import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('ChatGPT plan with an expired sign-in', () => {
  before(async () => {
    await browser.url('/?scenario=chatgpt-plan-expired')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('shows the reconnect message without the IPC wrapper and offers sign-in again', async () => {
    await $('[aria-label="Settings"]').click()
    const plan = $('[data-testid="models-agents-list"] [data-row="plan:chatgpt"]')
    await plan.waitForExist({ timeout: 15_000 })
    await expect(plan.$('.acp-row-chip')).toHaveText('Ready')
    await plan.$('button=Options').click()
    const section = $('[data-testid="chatgpt-plan-section"]')
    await expect(section).toHaveText('Using ChatGPT plan', { containing: true })
    await section.$('summary').click()
    await section.$('button=Refresh connection').click()
    await expect(section).toHaveText('ChatGPT sign-in expired. Reconnect this account.', {
      containing: true,
    })
    const text = await section.getText()
    expect(text).not.toContain('Error invoking remote method')
    expect(text).not.toContain('Error:')
    await expect(section.$('[data-testid="chatgpt-plan-connect"]')).toHaveText(
      'Continue with ChatGPT',
    )
    await saveElementScreenshot(
      '[data-testid="chatgpt-plan-section"]',
      'chatgpt-plan-sign-in-expired.png',
    )
  })
})
