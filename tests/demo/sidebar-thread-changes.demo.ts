import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Finished threads with unlanded work and no PR carry a muted branch glyph in the
// PR slot; the detail is tooltip / aria-label only, and clean rows stay bare.

async function glyphLabel(title: string): Promise<string | null> {
  const rows = await $$('.chats-list .chat-row')
  for (const row of rows) {
    if ((await row.$('.chat-title').getText()) !== title) continue
    const glyph = await row.$('.chat-changes-status')
    return (await glyph.isExisting()) ? glyph.getAttribute('aria-label') : null
  }
  throw new Error(`No sidebar row titled "${title}"`)
}

describe('sidebar thread changes glyph', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-thread-changes')
    await $('.chat-changes-status').waitForExist({ timeout: 30_000 })
  })

  it('marks unpushed commits and uncommitted changes, and nothing else', async () => {
    expect(await glyphLabel('Refactor auth')).toBe('2 unpushed commits')
    expect(await glyphLabel('Add a retry to uploads')).toBe('Uncommitted changes')
    expect(await glyphLabel('Update onboarding copy')).toBeNull()
    expect(await glyphLabel('Run the schema migration')).toBeNull()
    expect(await $$('.chat-changes-status')).toHaveLength(2)
    expect(await $$('.chat-pr-status')).toHaveLength(0)
    await saveAppScreenshot('sidebar-thread-changes.png')
  })
  for (const width of [800, 1600]) {
    it(`keeps changes glyphs visible at ${width}px`, async () => {
      await browser.setWindowSize(width, 900)
      expect(await glyphLabel('Refactor auth')).toBe('2 unpushed commits')
      expect(await glyphLabel('Add a retry to uploads')).toBe('Uncommitted changes')
      await expect($('.chat-changes-status')).toBeDisplayed()
      await saveAppScreenshot(`sidebar-thread-changes-${width}.png`)
    })
  }

  it('narrows to unlanded threads with Needs cleanup only, and restores the rest when turned off', async () => {
    await browser.setWindowSize(1280, 900)
    await $('.projects-filter-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    const toggle = await $('.context-menu-item*=Needs cleanup only')
    await toggle.click()
    await browser.keys('Escape')

    await browser.waitUntil(
      async () => {
        const titles = await $$('.chats-list .chat-title').map((row) => row.getText())
        return titles.sort().join(',') === ['Add a retry to uploads', 'Refactor auth'].join(',')
      },
      { timeout: 5_000, timeoutMsg: 'only the two unlanded threads should remain' },
    )
    await expect($('.projects-filter-btn')).toHaveElementClass('is-filtering')
    await saveAppScreenshot('sidebar-thread-changes-needs-cleanup.png')

    await $('.projects-filter-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await (await $('.context-menu-item*=Needs cleanup only')).click()
    await browser.keys('Escape')
    await browser.waitUntil(async () => (await $$('.chats-list .chat-title')).length === 4, {
      timeout: 5_000,
      timeoutMsg: 'every thread should be back once the filter is off',
    })
  })
})
