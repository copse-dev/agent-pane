import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const sidebarTitles = async (): Promise<string[]> =>
  browser.execute(() =>
    [...document.querySelectorAll('.chat-row .chat-title')].map((node) => node.textContent ?? ''),
  )

const MAIN = 'Fix flaky mermaid e2e'

/** Reveal a hover-only message action, then click it. */
async function hoverClick(messageSelector: string, actionSelector: string): Promise<void> {
  const message = $(messageSelector)
  await message.waitForDisplayed({ timeout: 10_000 })
  await message.scrollIntoView()
  await message.moveTo()
  const action = message.$(actionSelector)
  await action.waitForExist({ timeout: 5_000 })
  await action.click()
}

describe('Side chats beside the main thread', () => {
  before(async () => {
    await browser.url('/?scenario=side-chats')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  it('hides side chats from the sidebar, marks the branched message, and rolls the dot up to the parent', async () => {
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    expect(await sidebarTitles()).toEqual([MAIN, 'Release notes draft'])
    // The branched message carries a chip, with a dot while a side chat is unread.
    const chip = $('[data-message-id="sc-assistant-1"] .msg-side-chat-chip')
    await chip.waitForExist({ timeout: 10_000 })
    await expect(chip).toHaveText('1 side chat')
    await expect(chip).toHaveAttribute('data-unread', 'true')
    await saveElementScreenshot('#pane-chat', 'side-chat-anchor-chip.png')

    // Open the other thread: now the parent row shows the roll-up dot.
    await $('.chat-row*=Release notes draft').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Release notes draft')
    await $('.chat-row.is-unread .chat-unread-dot').waitForExist({ timeout: 10_000 })
    await expect($('.chat-row.is-unread .chat-title')).toHaveText(MAIN)
    await expect($('.chat-row.is-unread .chat-unread-dot')).toHaveAttribute(
      'aria-label',
      'Unread reply in a side chat',
    )
    await saveElementScreenshot('#pane-projects', 'side-chat-unread-rollup-sidebar.png')

    await $('.chat-row*=Fix flaky mermaid e2e').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
  })

  it('opens a side chat from its chip beside the main thread and reads it without leaving the thread', async () => {
    await $('[data-message-id="sc-assistant-1"] .msg-side-chat-chip').click()
    await $('.side-chat-body-host').waitForDisplayed({ timeout: 10_000 })
    // The main thread is still the open thread, and its conversation is still on screen.
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    await expect($('.msg-user')).toHaveText(expect.stringContaining('fails about one run in five'))
    expect(await sidebarTitles()).toEqual([MAIN, 'Release notes draft'])
    // The side chat shows what it reads, its transcript, and its own composer.
    await expect($('[data-side-chat-context]')).toHaveText(expect.stringContaining('Read-only'))
    await expect($('[data-side-chat-context]')).toHaveText(
      expect.stringContaining('The spec asserts on the rendered svg'),
    )
    await expect($$('.side-chat-msg')).toBeElementsArrayOfSize(2)
    await expect($('.side-chat-msg.is-assistant code')).toHaveText('waitForExist')
    await expect($('.side-chat-input')).toBeEnabled()
    // Showing it counts as reading it: the unread mark is gone.
    await expect($('.side-chat-row[data-side-chat-id="sc-side-1"]')).not.toHaveAttribute(
      'data-unread',
      'true',
    )
    // The titlebar control counts the live side chats.
    await expect($('[data-panel-control="side-chat"] .titlebar-btn-badge')).toHaveText('1')
    await saveElementScreenshot('#body', 'side-chat-beside-main-thread.png')
  })

  it('asks a question in the side chat and gets the reply there, not in the main thread', async () => {
    const mainMessages = await $$('#conversation .msg-user').length
    await $('.side-chat-input').setValue('Is waitForDisplayed enough on its own?')
    await $('.side-chat-send').click()
    await browser.waitUntil(async () => (await $$('.side-chat-msg')).length === 4, {
      timeout: 10_000,
      timeoutMsg: 'the side chat never showed the question and its reply',
    })
    await expect($$('.side-chat-msg')[2]).toHaveText('Is waitForDisplayed enough on its own?')
    expect(await $$('#conversation .msg-user').length).toBe(mainMessages)
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
  })

  it("keeps a reply's Side chat action beside Copy, clear of the reply's last line", async () => {
    const reply = $('[data-message-id="sc-assistant-1"] .message-body')
    await reply.scrollIntoView()
    await reply.moveTo()
    const action = reply.$('.msg-reply-actions .msg-side-chat')
    await action.waitForDisplayed({ timeout: 5_000 })
    const geometry = await browser.execute(() => {
      const body = document.querySelector('[data-message-id="sc-assistant-1"] .message-body')
      const side = body?.querySelector('.msg-reply-actions .msg-side-chat')
      const copy = body?.querySelector('.msg-reply-actions .msg-copy')
      if (!body || !side || !copy) throw new Error('reply actions missing')
      const bodyRect = body.getBoundingClientRect()
      const sideRect = side.getBoundingClientRect()
      return {
        sameRow: Math.abs(sideRect.top - copy.getBoundingClientRect().top) < 1,
        inTopHalf: sideRect.bottom <= bodyRect.top + bodyRect.height / 2,
        opacity: getComputedStyle(side).opacity,
      }
    })
    expect(geometry).toEqual({ sameRow: true, inTopHalf: true, opacity: '1' })
    await saveElementScreenshot(
      '[data-message-id="sc-assistant-1"]',
      'side-chat-reply-actions-top-right.png',
    )
  })

  it('starts a side chat from a hover action on a message and offers suggestions', async () => {
    await hoverClick('#conversation .msg-user', '.msg-side-chat')
    await $('.side-chat-empty').waitForDisplayed({ timeout: 10_000 })
    await expect($$('.side-chat-suggestion')).toBeElementsArrayOfSize(3)
    await expect($('[data-side-chat-context]')).toHaveText(
      expect.stringContaining('The mermaid e2e spec fails'),
    )
    await expect($('[data-panel-control="side-chat"] .titlebar-btn-badge')).toHaveText('2')
    // The new side chat is hidden from the sidebar like the others.
    expect(await sidebarTitles()).toEqual([MAIN, 'Release notes draft'])
    await saveElementScreenshot('#pane-files', 'side-chat-new-with-suggestions.png')
    await $$('.side-chat-suggestion')[0]?.click()
    await browser.waitUntil(async () => (await $$('.side-chat-msg')).length === 2, {
      timeout: 10_000,
    })
  })

  it('promotes a side chat to a thread', async () => {
    await $('[data-action="promote-side-chat"]').click()
    await browser.waitUntil(async () => (await sidebarTitles()).length === 3, {
      timeout: 10_000,
      timeoutMsg: 'the promoted thread never appeared in the sidebar',
    })
    // It is now an ordinary thread, active, carrying the parent slice and its own turns.
    await expect($('.chat-row.selected .chat-title')).toHaveText(
      expect.stringContaining('mermaid e2e spec fails'),
    )
    await expect($$('#conversation .msg-user')).toBeElementsArrayOfSize(2)
    await saveElementScreenshot('#body', 'side-chat-promoted-to-thread.png')
  })
})
