import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The sort menu beside the sidebar's thread filter: it lists the sorts, marks the
// current one, and re-orders a project's threads.

async function titles(): Promise<string[]> {
  const rows = await $$('.chats-list .chat-title')
  return rows.map((row) => row.getText())
}

async function openMenu(): Promise<void> {
  await $('.projects-sort-btn').click()
  await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
}

async function choose(label: string): Promise<void> {
  const items = await $$('.context-menu-item')
  for (const item of items) {
    if ((await item.getText()) === label) {
      await item.click()
      return
    }
  }
  throw new Error(`The sort menu has no "${label}"`)
}

describe('sidebar thread sort', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-thread-sort')
    await $('.projects-sort-btn').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await titles()).includes('Refactor auth'), {
      timeout: 30_000,
      timeoutMsg: 'the scenario threads must be listed',
    })
  })

  it('offers the sorts and marks the current one', async () => {
    await openMenu()
    const labels = await (await $$('.context-menu-item')).map((i) => i.getText())
    expect(labels).toEqual(['Activity order', 'Created', 'Thread name', 'Reverse order'])
    await expect($('.context-menu-item.is-checked')).toHaveText('Activity order')
    await saveAppScreenshot('sidebar-thread-sort-menu.png')
    await browser.keys('Escape')
  })

  it('sorts by thread name, then reverses', async () => {
    const before = await titles()
    expect(before.length).toBeGreaterThan(2)
    await openMenu()
    await choose('Thread name')
    const byName = await titles()
    expect(byName).toEqual(
      [...before].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    )
    await saveAppScreenshot('sidebar-thread-sort-by-name.png')

    await openMenu()
    await choose('Reverse order')
    expect(await titles()).toEqual([...byName].reverse())
  })
})
