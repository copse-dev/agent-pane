import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, waitForSettledLayout } from '../e2e/helpers/screenshot.ts'
import { join } from 'node:path'

/**
 * Standalone canvas prototype, not the Electron thread browser.
 * Capture the workshop itself: saveAppScreenshot pins #app to a product window,
 * which would overwrite the responsive prototype's intended size.
 */
async function capture(name: string) {
  await waitForSettledLayout('.workshop')
  await $('.workshop').saveScreenshot(join(E2E_SCREENSHOT_DIR, name))
}

async function expectNoOverflow() {
  const overflow = await browser.execute(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    pane: (() => {
      const pane = document.querySelector('.thread-pane')
      return pane ? pane.scrollWidth - pane.clientWidth : 0
    })(),
  }))
  expect(overflow.page).toBeLessThanOrEqual(1)
  expect(overflow.pane).toBeLessThanOrEqual(1)
}

describe('Thread view options prototype', () => {
  beforeEach(async () => {
    await browser.setWindowSize(1280, 920)
    await browser.url('/prototypes/thread-view-options.html')
    await $('[data-thread="side"]').waitForDisplayed()
    if ((await $('html').getAttribute('data-theme')) !== 'dark') await $('#theme').click()
  })

  it('opens the default grouped sidebar and resolves a request through its visible action', async () => {
    await expect($$('[data-group]')).toBeElementsArrayOfSize(4)
    await expect($$('[data-group="needs"] .thread-row')).toBeElementsArrayOfSize(3)
    await expect($$('[data-group="working"] .thread-row')).toBeElementsArrayOfSize(2)
    await expect($('[data-thread="side"]')).toHaveAttribute('aria-pressed', 'true')
    await expect($('[data-action="approve"]')).toBeDisplayedInViewport()
    await expectNoOverflow()
    await capture('thread-view-activity-dark.png')

    await $('[data-action="approve"]').click()
    await expect($$('[data-group="needs"] .thread-row')).toBeElementsArrayOfSize(2)
    await expect($$('[data-group="working"] .thread-row')).toBeElementsArrayOfSize(3)
    await expect($('[data-group="working"] [data-thread="side"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect($('.decision-reply')).toHaveText('Approved once · Continuing')
    await capture('thread-view-approved-dark.png')

    await $('[data-action="pause"]').click()
    await expect($('[data-group="earlier"] [data-thread="side"]')).toExist()
    await $('[data-action="resume"]').click()
    await expect($('[data-group="working"] [data-thread="side"]')).toExist()
  })

  it('keeps selection and drafts across project groups; filters, searches and collapses', async () => {
    await $('#reply').setValue('Keep the project context visible.')
    await $('[data-mode="projects"]').click()
    await expect($('#reply')).toHaveValue('Keep the project context visible.')
    await expect($$('[data-thread="side"]')).toBeElementsArrayOfSize(1)
    await expect($('[data-thread="side"]')).toHaveAttribute('aria-pressed', 'true')
    await capture('thread-view-projects-dark.png')
    await $('[data-collapse="Copse"]').click()
    await expect($('[data-thread="tags"]')).not.toBeDisplayed()
    await $('[data-collapse="Copse"]').click()
    await $('#project-filter').selectByVisibleText('Agent SDK')
    await expect($$('.thread-row')).toBeElementsArrayOfSize(2)
    await $('#search').setValue('reconnect')
    await expect($$('.thread-row')).toBeElementsArrayOfSize(1)
    await $('[data-thread="stream"]').click()
    await expect($('.detail-heading h2')).toHaveText('Streaming reconnect regression')
    await $('#search').setValue('no matching result')
    await expect($('.empty')).toHaveText(expect.stringContaining('No matching threads'))
    await $('[data-clear]').click()
    await expect($$('.thread-row')).toBeElementsArrayOfSize(10)
    await $('[data-filter="needs"]').click()
    await expect($$('.thread-row')).toBeElementsArrayOfSize(3)
  })

  it('sorts inbox columns in both directions and preserves selection', async () => {
    await $('[data-mode="inbox"]').click()
    await $('[data-sort="updated"]').click()
    await expect($('.thread-row')).toHaveAttribute('data-thread', 'tags')
    await $('[data-sort="updated"]').click()
    await expect($('.thread-row')).toHaveAttribute('data-thread', 'shortcuts')
    await $('[data-sort="title"]').click()
    await expect($('.thread-row')).toHaveAttribute('data-thread', 'tags')
    await expect($('[data-sort="title"]')).toHaveAttribute(
      'aria-label',
      'Sort by Thread, ascending',
    )
    await $('[data-sort="duration"]').click()
    await expect($('.thread-row')).toHaveAttribute('data-thread', 'stream')
    await expect($('[data-thread="side"]')).toHaveAttribute('aria-pressed', 'true')
    await $('#sort').selectByVisibleText('Activity order')
    await expectNoOverflow()
    await capture('thread-view-inbox-dark.png')
    await $('#theme').click()
    await expect($('html')).toHaveAttribute('data-theme', 'light')
    await capture('thread-view-inbox-light.png')
  })

  it('finds uncommitted work independently of status and combines the filter with project and search', async () => {
    await $('#changes-filter').click()
    await expect($('#changes-filter')).toHaveAttribute('aria-pressed', 'true')
    await expect($$('.thread-row')).toBeElementsArrayOfSize(6)
    await expect($('[data-thread="acp"]')).not.toExist()
    await expect($('[data-thread="stream"]')).not.toExist()
    await expect($('[data-group="recent"] [data-thread="picker"]')).toExist()
    await expect($('[data-thread="events"] .change-badge')).toHaveAttribute(
      'aria-label',
      '1 uncommitted file',
    )
    await expect($('.work-summary')).toHaveText(expect.stringContaining('2 unstaged · 1 untracked'))
    await capture('thread-view-uncommitted-activity.png')

    await $('#search').setValue('Model picker')
    await expect($$('.thread-row')).toBeElementsArrayOfSize(1)
    await $('#search').clearValue()
    await $('#project-filter').selectByVisibleText('Copse')
    await expect($$('.thread-row')).toBeElementsArrayOfSize(4)
    await $('[data-mode="projects"]').click()
    await expect($$('.thread-row')).toBeElementsArrayOfSize(4)
    await expect($('#changes-filter')).toHaveAttribute('aria-pressed', 'true')
    await $('#project-filter').selectByVisibleText('All projects')
    await $('[data-mode="inbox"]').click()
    await $('[data-sort="changes"]').click()
    await expect($('.thread-row')).toHaveAttribute('data-thread', 'tags')
    await expect($('[data-thread="tags"] .changes-cell')).toHaveText('6 files')
    await capture('thread-view-uncommitted-inbox.png')
    await $('[data-sort="changes"]').click()
    await expect($('.thread-row')).toHaveAttribute('data-thread', 'events')
    await expect($('[data-sort="changes"]')).toHaveAttribute(
      'aria-label',
      'Sort by Uncommitted, ascending',
    )
    await $('#search').setValue('reconnect')
    await expect($('.empty')).toBeDisplayed()
    await $('[data-clear]').click()
    await expect($('#changes-filter')).toHaveAttribute('aria-pressed', 'false')
    await expect($$('.thread-row')).toBeElementsArrayOfSize(10)
  })

  it('supports narrow list-to-conversation navigation and a question response', async () => {
    await browser.setWindowSize(390, 844)
    await browser.url('/prototypes/thread-view-options.html')
    await expect($('#detail')).not.toBeDisplayed()
    await expectNoOverflow()
    await capture('thread-view-mobile-list.png')
    await $('[data-thread="events"]').click()
    await expect($('#detail')).toBeDisplayed()
    await $('[data-answer="PR updates first"]').click()
    await expect($('.decision-reply')).toHaveText('PR updates first · Answer submitted')
    await expectNoOverflow()
    await capture('thread-view-mobile-thread.png')
    await $('#back').click()
    await expect($('[data-group="working"] [data-thread="events"]')).toExist()
    await $('[data-mode="inbox"]').click()
    await expectNoOverflow()
    await $('[data-thread="side"]').click()
    await expect($('[data-action="approve"]')).toBeDisplayedInViewport()
    await expectNoOverflow()
  })

  it('rejects without running, safely displays a follow-up, and restores sample state', async () => {
    await $('[data-action="reject"]').click()
    await expect($('.decision-body h4')).toHaveText('Command rejected')
    await expect($$('[data-group="working"] .thread-row')).toBeElementsArrayOfSize(2)
    await $('#reply').setValue('<img src=x onerror=alert(1)> Keep the sandbox.')
    await $('.send').click()
    await expect($$('.conversation img')).toBeElementsArrayOfSize(0)
    await expect($('.conversation')).toHaveText(
      expect.stringContaining('<img src=x onerror=alert(1)>'),
    )
    await expect($('[data-group="needs"] [data-thread="side"]')).toExist()
    await $('#reset').click()
    await expect($$('[data-group="needs"] .thread-row')).toBeElementsArrayOfSize(3)
    await expect($('[data-action="approve"]')).toBeDisplayedInViewport()
  })
})
