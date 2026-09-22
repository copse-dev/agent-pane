import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('double submit guard', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('only sends one message when submit is fired twice in quick succession', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-double-submit', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const firstPrompt = 'Suggest one safe refactor for the parser module.'
    const queuedPrompt = 'Which unit tests should cover that refactor?'
    const scenario = await installMockScenario({
      title: 'Review parser refactor',
      turns: [
        {
          user: firstPrompt,
          responses: [
            {
              waitFor: 'parser-review',
              text: 'Extract the repeated parser error handling into one small helper so each branch can return a consistent error.',
            },
          ],
        },
        {
          user: queuedPrompt,
          responses: [
            {
              text: 'Cover malformed input, an empty payload, and valid input that still parses successfully.',
            },
          ],
        },
      ],
    })

    // Hold the first normal request while the renderer receives duplicate send
    // events for a genuine follow-up.
    await setComposerValue(firstPrompt)
    await $('.submit-btn').click()
    await scenario.waitForHold('parser-review')

    // Fire two synchronous clicks back-to-back, exactly as a frozen renderer
    // would replay buffered input events once the main thread unblocks.
    await browser.execute(() => {
      const input = document.querySelector('.prompt-input') as HTMLElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.textContent = 'Which unit tests should cover that refactor?'
      btn?.click()
      btn?.click()
    })

    // The guard must collapse the double click into a single queued message.
    await expect($('.footer-queue')).toHaveText('1 queued', { wait: 5_000 })
    const queuedBadges = await $$('.message-queued-badge')
    await expect(queuedBadges).toHaveLength(1)

    await saveAppScreenshot('double-submit-single-queued.png')

    await scenario.release('parser-review')
    await waitForAgentIdle(60_000)
    await scenario.assertComplete()

    // After draining, the thread holds exactly the two distinct user messages —
    // not three (which is what a duplicate send would have produced).
    const userMessages = await $$('.msg-user .message-text')
    await expect(userMessages).toHaveLength(2)
    await expect(userMessages[0]).toHaveText(firstPrompt)
    await expect(userMessages[1]).toHaveText(queuedPrompt)
    const assistantMessages = await $$('.msg-assistant .message-text')
    const finalReply = assistantMessages.at(-1)
    if (!finalReply) throw new Error('expected a final assistant reply')
    await expect(finalReply).toHaveText(
      'Cover malformed input, an empty payload, and valid input that still parses successfully.',
      { containing: true },
    )
    await saveAppScreenshot('double-submit-drained.png')
  })
})
