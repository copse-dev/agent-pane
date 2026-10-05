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
})
