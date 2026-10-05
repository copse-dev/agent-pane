import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const sidebarTitles = async (): Promise<string[]> =>
  browser.execute(() =>
    [...document.querySelectorAll('.chat-row .chat-title')].map((node) => node.textContent ?? ''),
  )

const MAIN = 'Fix flaky mermaid e2e'

/** The panel control toggles, so only click it when the Context pane is not already showing. */
async function openContext(): Promise<void> {
  if (!(await $('.thread-context').isDisplayed())) {
    if (!(await $('#pane-files').isDisplayed()))
      await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open thread context"]').click()
  }
  await $('.thread-context').waitForDisplayed({ timeout: 20_000 })
}

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

describe('Side chats beside the main thread, and the thread Context panel', () => {
  before(async () => {
    await browser.url('/?scenario=side-chats-context')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openContext()
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

  it('lists repos, side chats, links, mentions and subagents for the open thread', async () => {
    await openContext()
    await expect($('[data-context-section="repos"] .thread-context-repo')).toHaveText(
      expect.stringContaining('fix/mermaid-wait'),
    )
    await expect($$('.thread-context-row[data-side-chat-id]')).toBeElementsArrayOfSize(2)
    await expect($('.thread-context-row[data-side-chat-id="sc-side-1"]')).toHaveAttribute(
      'data-unread',
      'true',
    )
    await expect($('.thread-context-row[data-side-chat-id="sc-side-2"]')).toHaveAttribute(
      'data-archived',
      'true',
    )
    await expect($('[data-link-group="pr"] .thread-context-row')).toHaveText('acme/widgets#42')
    await expect($('[data-link-group="url"] .thread-context-row')).toHaveText(
      'webdriver.io/docs/api/element/waitForDisplayed',
    )
    await expect($('[data-link-group="thread"] .thread-context-row')).toHaveText(
      'Release notes draft',
    )
    await $('[data-link-group="mentioned-in"]').waitForExist({ timeout: 10_000 })
    await expect($('[data-link-group="mentioned-in"] .thread-context-row')).toHaveText(
      'Release notes draft',
    )
    await expect($$('[data-subagent-id]')).toBeElementsArrayOfSize(1)
    await saveElementScreenshot('#pane-files', 'side-chats-context-panel.png')
  })

  it('opens a side chat beside the main thread and reads it without leaving the thread', async () => {
    await $('.thread-context-row[data-side-chat-id="sc-side-1"]').click()
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

  it('archives and restores side chats from the Context panel', async () => {
    await $('.chat-row*=Fix flaky mermaid e2e').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    await openContext()
    const overflow = await browser.execute(() => {
      const viewer = document.querySelector('#context-viewer-host')
      return viewer ? viewer.scrollWidth - viewer.clientWidth : -1
    })
    expect(overflow).toBe(0)
    await $('[data-action="archive-side-chat"][data-side-chat-id="sc-side-1"]').click()
    await expect($('.thread-context-row[data-side-chat-id="sc-side-1"]')).toHaveAttribute(
      'data-archived',
      'true',
    )
    await $('[data-action="restore-side-chat"][data-side-chat-id="sc-side-2"]').click()
    await expect($('.thread-context-row[data-side-chat-id="sc-side-2"]')).not.toHaveAttribute(
      'data-archived',
      'true',
    )
    await saveElementScreenshot('#pane-files', 'side-chats-archive-restore.png')
  })
})
