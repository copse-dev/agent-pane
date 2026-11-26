import { $, browser, expect } from '@wdio/globals'
import { parkPointer, saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { buildDemoFixturePage } from './helpers/demo-fixture-page.ts'

// managed-agents-client.test.ts proves a Claude Managed Agents stream that
// closes before `session.status_idle` throws. This browser fixture replays the
// chunks agent-service.ts sends for that error through the real renderer, and
// checks the turn ends on an error callout rather than passing as finished.
describe('Claude Agent stream that ends mid-turn', () => {
  it('ends the half-received reply with an error callout', async () => {
    const page = await buildDemoFixturePage('scripted-turn-fixture')
    await browser.url(`${page}?turn=managed-agent-stream-ended`)
    await $('.prompt-input').waitForExist()
    await browser.execute(async () => {
      await document.fonts.ready
    })
    await browser.execute(() => {
      const composer = document.querySelector<HTMLElement>('.prompt-input')
      if (!composer) throw new Error('Missing composer')
      composer.textContent = 'Update the changelog on the remote sandbox.'
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await $('.submit-btn').click()

    const callout = $('.msg-assistant .markdown-alert-caution')
    await callout.waitForDisplayed()
    await expect(callout).toHaveText(
      expect.stringContaining(
        'Claude Agent stream ended before the turn finished. The remote session may still be running.',
      ),
    )
    await expect($('.msg-assistant .message-text')).toHaveText(
      expect.stringContaining('I am updating the changelog'),
    )
    // The notice is a callout of its own, not the tail of the reply's sentence.
    await expect($('.msg-assistant .message-text')).not.toHaveText(
      expect.stringContaining('[!CAUTION]'),
    )
    await browser.waitUntil(
      async () =>
        !(await $('.msg-assistant .message-text').getAttribute('class'))?.includes('is-streaming'),
      { timeoutMsg: 'expected the turn to settle' },
    )

    await parkPointer()
    await saveAppScreenshot('managed-agent-stream-ended.png')
  })
})
