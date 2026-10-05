import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const sidebarTitles = async (): Promise<string[]> =>
  browser.execute(() =>
    [...document.querySelectorAll('.chat-row .chat-title')].map((node) => node.textContent ?? ''),
  )

describe('Side chats and the thread Context panel', () => {
  before(async () => {
    await browser.url('/?scenario=side-chats-context')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const pane = $('#pane-files')
    if (!(await pane.isDisplayed())) await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open thread context"]').click()
    await $('.thread-context').waitForDisplayed({ timeout: 20_000 })
  })

  it('hides side chats from the sidebar and rolls their unread dot up to the parent', async () => {
    await expect($('.chat-row.selected .chat-title')).toHaveText('Fix flaky mermaid e2e')
    expect(await sidebarTitles()).toEqual(['Fix flaky mermaid e2e', 'Release notes draft'])
    // The unread side chat marks its parent, which is the open thread, so the dot is
    // suppressed there and the other row carries none.
    await expect($$('.chat-row .chat-unread-dot')).toBeElementsArrayOfSize(0)

    // Open the other thread: now the parent shows the roll-up dot.
    await $('.chat-row*=Release notes draft').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Release notes draft')
    await $('.chat-row.is-unread .chat-unread-dot').waitForExist({ timeout: 10_000 })
    await expect($('.chat-row.is-unread .chat-title')).toHaveText('Fix flaky mermaid e2e')
    await expect($('.chat-row.is-unread .chat-unread-dot')).toHaveAttribute(
      'aria-label',
      'Unread reply in a side chat',
    )
    await saveElementScreenshot('#pane-projects', 'side-chat-unread-rollup-sidebar.png')

    await $('.chat-row*=Fix flaky mermaid e2e').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Fix flaky mermaid e2e')
  })

  it('lists repos, side chats, links, mentions and subagents for the open thread', async () => {
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

  it('opens an existing side chat, shows what it reads, and returns to the parent', async () => {
    await $('.thread-context-row[data-side-chat-id="sc-side-1"]').click()
    await $('[data-context="side-of"]').waitForDisplayed()
    await expect($('[data-context="side-of"]')).toHaveText(
      expect.stringContaining('Fix flaky mermaid e2e'),
    )
    await expect($('[data-context="side-of"]')).toHaveText(expect.stringContaining('Read-only'))
    // A side chat cannot start another.
    await expect($('[data-action="new-side-chat"]')).toBeDisabled()
    // Still hidden from the sidebar while it is the open thread.
    expect(await sidebarTitles()).toEqual(['Fix flaky mermaid e2e', 'Release notes draft'])
    await saveElementScreenshot('#body', 'side-chat-open-with-context.png')

    await $('[data-action="back-to-parent"]').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Fix flaky mermaid e2e')
    await expect($('[data-context="side-of"]')).not.toBeDisplayed()
    // Opening the side chat read it: the unread mark is gone from its row.
    await expect($('.thread-context-row[data-side-chat-id="sc-side-1"]')).not.toHaveAttribute(
      'data-unread',
      'true',
    )
  })

  it('starts a side chat, archives it, and restores an archived one', async () => {
    await $('[data-action="new-side-chat"]').click()
    await $('[data-context="side-of"]').waitForDisplayed()
    await expect($('.chat-row.selected .chat-title')).not.toExist()
    expect(await sidebarTitles()).toEqual(['Fix flaky mermaid e2e', 'Release notes draft'])
    await $('[data-action="back-to-parent"]').click()
    await expect($$('.thread-context-row[data-side-chat-id]')).toBeElementsArrayOfSize(3)
    // A long side chat title must ellipsize, never widen the column.
    const overflow = await browser.execute(() => {
      const viewer = document.querySelector('#context-viewer-host')
      return viewer ? viewer.scrollWidth - viewer.clientWidth : -1
    })
    expect(overflow).toBe(0)

    // Side chats list oldest first, so the one just created is the last active row.
    // Archiving it must leave the seeded unread one alone.
    const archive = await $$('[data-action="archive-side-chat"]')
    const created = archive[archive.length - 1]
    if (!created) throw new Error('No side chat to archive')
    expect(await created.getAttribute('data-side-chat-id')).not.toBe('sc-side-1')
    await created.click()
    await expect($$('[data-action="archive-side-chat"]')).toBeElementsArrayOfSize(1)
    await expect($$('[data-action="restore-side-chat"]')).toBeElementsArrayOfSize(2)
    await expect($('.thread-context-row[data-side-chat-id="sc-side-1"]')).not.toHaveAttribute(
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
