import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Threads of projects that were never opened this session still show their titles:
// they are read in the background after startup, so the Status grouping lists them
// beside the open project's thread without a project switch.

async function titles(): Promise<string[]> {
  const rows = await $$('.chats-list .chat-title')
  return rows.map((row) => row.getText())
}

describe('sidebar listing projects not opened yet', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-other-projects')
    await $('.chats-list .chat-title').waitForExist({ timeout: 30_000 })
  })

  it("lists the other projects' thread titles, each naming its project", async () => {
    await browser.waitUntil(
      async () => (await titles()).includes('Add pagination to the list endpoint'),
      { timeout: 10_000, timeoutMsg: 'threads of unopened projects must be listed' },
    )
    const shown = await titles()
    expect(shown).toEqual(
      expect.arrayContaining([
        'Open project thread',
        'Rewrite the install guide',
        'Fix broken anchors',
        'Add pagination to the list endpoint',
      ]),
    )
    const owners = await $$('.chat-thread-owner')
    const names = await owners.map((owner) => owner.getText())
    expect(names).toEqual(expect.arrayContaining(['· docs-site', '· api-server']))
    await saveAppScreenshot('sidebar-other-projects.png')
  })

  it('counts the unopened projects in the Show menu', async () => {
    await $('.projects-filter-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    const items = await $$('.context-menu-item')
    const labels = await items.map((item) => item.getText())
    expect(labels.some((label) => label.includes('docs-site') && label.includes('2'))).toBe(true)
    await browser.keys('Escape')
  })
  for (const width of [800, 1600]) {
    it(`lists unopened threads at ${width}px`, async () => {
      await browser.setWindowSize(width, 900)
      expect(await titles()).toHaveLength(4)
      await expect($('.projects-filter-btn')).toBeDisplayed()
      await saveAppScreenshot(`sidebar-other-projects-${width}.png`)
    })
  }
})
