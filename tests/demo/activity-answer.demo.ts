import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// A question an agent is blocked on is answered from the Activity home's detail
// pane, through the ask dialog's own queue: each question with the agent's quick
// answers and a field, Send answer in the action bar, and the row gone once it
// has been sent.

describe('answering a question from the Activity home', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home-question')
    await $('#activity-home .activity-row[data-state="needs-answer"]').waitForExist({
      timeout: 30_000,
    })
    await $('#activity-home .activity-answer-input').waitForExist({ timeout: 10_000 })
  })

  it('shows the questions, their quick answers and a field for each', async () => {
    await expect($('#activity-home .activity-detail-title')).toHaveText('Schema bump')
    const questions = await $$('#activity-home .activity-question').getElements()
    expect(questions.length).toBe(2)
    expect((await $$('#activity-home .activity-option').getElements()).length).toBe(2)
    expect((await $$('#activity-home .activity-answer-input').getElements()).length).toBe(2)
    await expect($('#activity-home .activity-answer')).toBeDisabled()
    // The agent's question is not also a modal over this screen.
    await expect($('#ask-user-dialog')).not.toBeDisplayed()
    await saveAppScreenshot('activity-answer-empty.png')
  })

  it('fills a field from a quick answer, then sends every answer', async () => {
    await $$('#activity-home .activity-option')[0]?.click()
    const [first, second] = await $$('#activity-home .activity-answer-input').getElements()
    expect(await first?.getValue()).toBe('Columns first')
    await second?.click()
    await browser.keys('Yes, until 1.5')
    await expect($('#activity-home .activity-answer')).toBeEnabled()
    await saveAppScreenshot('activity-answer-filled.png')

    await $('#activity-home .activity-answer').click()
    await browser.waitUntil(
      async () =>
        (await $$('#activity-home .activity-row[data-state="needs-answer"]').getElements())
          .length === 0,
      { timeout: 10_000, timeoutMsg: 'an answered question must leave the list' },
    )
    await saveAppScreenshot('activity-answer-sent.png')
  })
})
