import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

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

describe('The thread Context panel', () => {
  before(async () => {
    await browser.url('/?scenario=thread-context')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openContext()
    await $('#resizer-files').dragAndDrop({ x: 240, y: 0 })
  })

  it('lists repos, side chats, links, mentions and subagents for the open thread', async () => {
    await expect($('[data-context-storage-size]')).toHaveText('24 KB')
    await expect($('[data-action="archive-thread"]')).toBeEnabled()
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    await expect($('[data-context-section="repos"] .thread-context-repo')).toHaveText(
      expect.stringContaining('Primary'),
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
    await expect($('[data-link-group="pr"] .thread-context-title')).toHaveText('acme/widgets#42')
    await expect($('[data-context-section="sources"] .thread-context-row')).toHaveText(
      'webdriver.io/docs/api/element/waitForDisplayed',
    )
    await expect($('[data-link-group="thread"] .thread-context-title')).toHaveText(
      'Release notes draft',
    )
    await $('[data-link-group="mentioned-in"]').waitForExist({ timeout: 10_000 })
    await expect($('[data-link-group="mentioned-in"] .thread-context-row')).toHaveText(
      'Release notes draft',
    )
    await expect($$('[data-subagent-id]')).toBeElementsArrayOfSize(1)
    const overflow = await browser.execute(() => {
      const viewer = document.querySelector('#context-viewer-host')
      return viewer ? viewer.scrollWidth - viewer.clientWidth : -1
    })
    expect(overflow).toBe(0)
    const layout = await browser.execute(() => {
      const header = document.querySelector('#context-host')?.getBoundingClientRect()
      const content = document.querySelector('#context-viewer-host')?.getBoundingClientRect()
      const row = document.querySelector('.thread-context-repo')
      return {
        aligned: header?.left === content?.left && header?.width === content?.width,
        stacked: !!header && !!content && header.bottom <= content.top,
        border: row ? getComputedStyle(row).borderTopWidth : null,
      }
    })
    expect(layout).toEqual({ aligned: true, stacked: true, border: '0px' })
    await expect($('#resizer-tree')).not.toBeDisplayed()
    await expect($('#right-sidebar')).not.toBeDisplayed()
    await expect($$('.thread-context-index-row')).toBeElementsArrayOfSize(0)
    await expect($('.thread-context-thread-title')).toHaveText(MAIN)
    const paneHeight = await browser.execute(() => {
      const first = document.querySelector('[data-context-section="subagents"]')
      return first?.getBoundingClientRect().height ?? 0
    })
    expect(paneHeight).toBeLessThan(110)
    await saveElementScreenshot('#pane-files', 'side-chats-context-panel.png')
  })

  it('expands and closes the single context panel', async () => {
    await $('[aria-label="Expand context over chat"]').click()
    await expect($('#body')).toHaveElementClass('is-right-panel-maximized')
    await $('[aria-label="Restore context"]').click()
    await $('[aria-label="Close context"]').click()
    await expect($('#pane-files')).not.toBeDisplayed()
    await openContext()
  })

  it('archives and restores side chats from the panel', async () => {
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

  it('opens a side chat from its row beside the main thread', async () => {
    await $('.thread-context-row[data-side-chat-id="sc-side-2"]').click()
    await $('.side-chat-body-host').waitForDisplayed({ timeout: 10_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(MAIN)
    await expect($('.side-chat-row.is-selected')).toHaveAttribute('data-side-chat-id', 'sc-side-2')
    await expect($('#right-sidebar')).toBeDisplayed()
  })
  it('archives the current thread from Context', async () => {
    await openContext()
    await $('[data-action="archive-thread"]').click()
    await expect($('.chat-row.selected .chat-title')).not.toHaveText(MAIN)
    await saveElementScreenshot('#pane-files', 'thread-context-after-archive.png')
  })
})
