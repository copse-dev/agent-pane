import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

async function assertAtBottom(): Promise<void> {
  const metrics = await browser.execute(() => {
    const list = document.querySelector<HTMLElement>('.messages-list')
    const activity = list?.querySelector<HTMLElement>('.agent-activity')
    if (!list || !activity || activity.hidden) throw new Error('Expected a live transcript')
    return {
      overflow: list.scrollHeight - list.clientHeight,
      gap: list.scrollHeight - list.clientHeight - list.scrollTop,
      activityBottom: activity.getBoundingClientRect().bottom,
      listBottom: list.getBoundingClientRect().bottom,
    }
  })
  assert.ok(metrics.overflow > 100, 'fixture must overflow the transcript viewport')
  assert.ok(metrics.gap <= 1, `expected the actual bottom; gap was ${String(metrics.gap)}px`)
  assert.ok(metrics.activityBottom <= metrics.listBottom + 1, 'the live activity row must fit')
}

describe('thread switching with pending permissions', () => {
  it('keeps the complete transcript in view while permission prompts follow the selected thread', async () => {
    await browser.url('/?scenario=approval-thread-switch-scroll')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await $('.messages-list [data-message-id="approval-scroll-a-19"]').waitForExist()

    for (const suffix of ['b', 'a', 'b']) {
      await $(`.chat-row[data-thread-id="demo-approval-scroll-${suffix}"]`).click()
      await $(`.messages-list [data-message-id="approval-scroll-${suffix}-19"]`).waitForExist()
      await expect(dialog).toBeDisplayed()
      await expect(dialog.$('.approval-body')).toHaveText(`node scripts/check-${suffix}.mjs`)
      await assertAtBottom()
    }
    await saveAppScreenshot('approval-thread-switch-prompt.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true })
    await assertAtBottom()
    await saveAppScreenshot('approval-thread-switch-bottom.png')

    // Leaving a still-pending prompt must also land at the bottom of the
    // already visited thread, without resurrecting its answered request.
    await $('.chat-row[data-thread-id="demo-approval-scroll-a"]').click()
    await dialog.waitForDisplayed()
    await $('.chat-row[data-thread-id="demo-approval-scroll-b"]').click()
    await dialog.waitForDisplayed({ reverse: true })
    await assertAtBottom()
  })
})
