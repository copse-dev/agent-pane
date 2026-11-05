import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedScrollStreamingFixture } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  navigationTextOverlaps,
  waitForTranscriptScrollSettled,
} from './helpers/scroll-to-bottom.ts'

const FIRST_PROMPT = 'Suggest how to make this module’s error handling clearer.'
const QUEUED_PROMPTS = [
  'Which unit tests should cover that change?',
  'What should the README explain about it?',
] as const

describe('queued chats stay pinned to the bottom', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('keeps queued messages pinned below a scrollable conversation', async function () {
    resetUserData()
    seedScrollStreamingFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.messages-list .msg-assistant').waitForExist({ timeout: 30_000 })

    const scenario = await installMockScenario({
      title: 'Clarify module errors',
      turns: [
        {
          user: FIRST_PROMPT,
          responses: [
            {
              waitFor: 'module-refactor',
              text: 'Use one error-normalization helper at the module boundary so callers receive the same shape from every failure path.',
            },
          ],
        },
        {
          user: QUEUED_PROMPTS[0],
          responses: [
            {
              text: 'Test a malformed request, a dependency failure, and a successful request to confirm the helper preserves each outcome.',
            },
          ],
        },
        {
          user: QUEUED_PROMPTS[1],
          responses: [
            {
              text: 'Document the normalized error fields, when callers can retry, and one short example of handling a validation failure.',
            },
          ],
        },
      ],
    })

    // Keep a normal request running while follow-ups are queued.
    await setComposerValue(FIRST_PROMPT)
    await $('.submit-btn').click()
    await scenario.waitForHold('module-refactor')

    // Queue two follow-ups while the agent is busy.
    for (const [index, text] of QUEUED_PROMPTS.entries()) {
      await setComposerValue(text)
      await $('.submit-btn').click()
      await browser.waitUntil(
        async () =>
          (await $$('.conversation-queued .msg-queued').getElements()).length === index + 1,
        { timeout: 5_000 },
      )
    }

    const queuedItems = await $$('.conversation-queued .msg-queued').getElements()
    expect(queuedItems).toHaveLength(2)
    await expect($('.conversation-queued .message-queued-badge')).toHaveText('QUEUED')

    // Scroll the message list to the top — the pinned queue panel must remain visible.
    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    // Settled, not paused: the scroll handler shows Back to latest, and the
    // capture waits for position, size and both controls to stop moving.
    await waitForTranscriptScrollSettled(true)
    expect(await browser.execute(() => document.querySelector('.messages-list')?.scrollTop)).toBe(0)

    const panelVisibleAfterScroll = await browser.execute(() => {
      const panel = document.querySelector('.conversation-queued')
      if (!(panel instanceof HTMLElement) || panel.hidden) return false
      const rect = panel.getBoundingClientRect()
      return rect.height > 0 && rect.bottom <= window.innerHeight + 1
    })
    expect(panelVisibleAfterScroll).toBe(true)
    // The navigation row docks between the transcript and the queued panel; it
    // must not cover a word of either.
    expect(await navigationTextOverlaps()).toEqual([])

    await saveAppScreenshot('queued-pinned-scrolled-top.png')
    await scenario.release('module-refactor')
    // The agent can briefly read as idle after the first reply, before the
    // queued prompt dispatches. Wait for every scripted response to be served.
    await scenario.waitForComplete(60_000)
    await waitForAgentIdle(60_000)
    await scenario.assertComplete()
  })
})
