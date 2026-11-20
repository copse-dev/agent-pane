import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { pinDemoClock } from './helpers/fixed-clock.ts'

// A question an agent is blocked on is answered from the Activity home's detail
// pane, through the ask dialog's own queue: each question with the agent's quick
// answers and a field, Send answer in the action bar, and the row gone once it
// has been sent.

describe('answering a question from the Activity home', () => {
  let virtualTimeEnabled = false

  after(async () => {
    // A fresh browser context restores the ordinary clock for later scenarios.
    if (virtualTimeEnabled) await browser.reloadSession()
  })

  before(async () => {
    await pinDemoClock()
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

  it('keeps a quick-answer click intact across the age refresh', async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home-question')
    const choice = $('#activity-home .activity-option')
    await choice.waitForClickable()
    const position = await choice.getLocation()
    const size = await choice.getSize()
    const pointer = {
      type: 'pointer',
      id: 'activity-answer-click',
      parameters: { pointerType: 'mouse' },
    } as const
    await browser.performActions([
      {
        ...pointer,
        actions: [
          {
            type: 'pointerMove',
            duration: 0,
            x: Math.round(position.x + size.width / 2),
            y: Math.round(position.y + size.height / 2),
          },
          { type: 'pointerDown', button: 0 },
        ],
      },
    ])
    try {
      // Advance the browser clock through the real age timers while a native
      // pointer gesture is in flight. No product timer or test-only API changes.
      virtualTimeEnabled = true
      await browser.sendCommand('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: 90_001,
        maxVirtualTimeTaskStarvationCount: 100,
      })
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              document
                .querySelector('#activity-home .activity-detail-meta')
                ?.textContent.includes('1 minute') ?? false,
          ),
        { timeout: 10_000, timeoutMsg: 'the Activity age must refresh while the click is held' },
      )
      await expect(choice).toBeFocused()
      await browser.performActions([{ ...pointer, actions: [{ type: 'pointerUp', button: 0 }] }])
      await expect($('#activity-home .activity-answer-input')).toHaveValue('Columns first')
      await expect($('#activity-home .activity-answer')).toBeEnabled()
      await saveAppScreenshot('activity-answer-after-refresh.png')
    } finally {
      await browser.releaseActions()
    }
  })
})
